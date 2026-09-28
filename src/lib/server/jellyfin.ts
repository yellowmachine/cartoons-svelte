import { env } from '$env/dynamic/private';
import type { ClientSession, FolderOption, PlaylistItem } from '$lib/types';

const PLAYLIST_NAME = 'Para ver hoy';
const ITEM_TYPES = 'Movie,Episode,Video';

type JfItem = {
	Id: string;
	Name: string;
	Type?: string;
	IsFolder?: boolean;
	Path?: string;
	SeriesName?: string;
	ImageTags?: Record<string, string>;
};

function normalizePath(path: string): string {
	return path.replaceAll('\\', '/').replace(/\/+$/, '');
}

function config() {
	const url = env.JELLYFIN_URL;
	const userId = env.JELLYFIN_USER_ID;
	const apiKey = env.JELLYFIN_API_KEY;
	if (!url || !userId || !apiKey) {
		throw new Error(
			'Faltan variables de entorno de Jellyfin: JELLYFIN_URL, JELLYFIN_USER_ID, JELLYFIN_API_KEY'
		);
	}
	return { url: url.replace(/\/+$/, ''), userId, apiKey };
}

async function jf<T>(
	path: string,
	params: Record<string, string> = {},
	init: RequestInit = {}
): Promise<T> {
	const { url, apiKey } = config();
	const target = new URL(url + path);
	for (const [key, value] of Object.entries(params)) target.searchParams.set(key, value);

	const res = await fetch(target, {
		...init,
		headers: {
			'X-Emby-Token': apiKey,
			'Content-Type': 'application/json',
			...init.headers
		}
	});

	if (!res.ok) {
		const body = await res.text().catch(() => '');
		throw new Error(`Jellyfin ${path} respondió ${res.status}: ${body}`);
	}
	if (res.status === 204) return undefined as T;
	const text = await res.text();
	return (text ? JSON.parse(text) : undefined) as T;
}

/**
 * Primer segmento de `itemPath` justo debajo de `rootPath` — la "carpeta madre" de un item,
 * sin importar cuántos niveles haya entre medias (temporadas, subcarpetas, etc.).
 * P.ej. root "/media/cartoons" + item "/media/cartoons/looney toones/1/bugs.mp4" → "looney toones".
 */
function folderUnderRoot(itemPath: string, rootPath: string): string | undefined {
	const item = normalizePath(itemPath);
	const root = normalizePath(rootPath);
	if (!item.startsWith(root + '/')) return undefined;
	return item.slice(root.length + 1).split('/')[0];
}

async function getItemPath(itemId: string): Promise<string | undefined> {
	const { userId } = config();
	const item = await jf<JfItem>(`/Users/${userId}/Items/${itemId}`, { Fields: 'Path' });
	return item.Path;
}

export async function listFolders(): Promise<FolderOption[]> {
	const { userId } = config();
	const views = await jf<{ Items: JfItem[] }>(`/Users/${userId}/Views`, { Fields: 'Path' });

	const folders: FolderOption[] = [];
	for (const view of views.Items) {
		const children = await jf<{ Items: JfItem[] }>(`/Users/${userId}/Items`, {
			ParentId: view.Id,
			Recursive: 'false',
			Fields: 'Path'
		});

		const realFolders = children.Items.filter((c) => c.IsFolder);
		if (realFolders.length > 0) {
			for (const folder of realFolders) folders.push({ id: folder.Id, name: folder.Name });
			continue;
		}

		// Esta biblioteca es "plana" (Jellyfin devuelve los ficheros directamente, sin
		// exponer las carpetas físicas): derivamos la carpeta madre a partir del Path
		// de cada item, recortado justo debajo de la raíz de la biblioteca.
		if (!view.Path) continue;
		const seen = new Set<string>();
		for (const item of children.Items) {
			if (!item.Path) continue;
			const name = folderUnderRoot(item.Path, view.Path);
			if (!name || seen.has(name)) continue;
			seen.add(name);
			folders.push({ id: `path:${view.Id}:${encodeURIComponent(name)}`, name });
		}
	}

	return folders;
}

async function unwatchedItemsForRealFolder(folderId: string): Promise<JfItem[]> {
	const { userId } = config();
	const { Items } = await jf<{ Items: JfItem[] }>(`/Users/${userId}/Items`, {
		ParentId: folderId,
		Recursive: 'true',
		IncludeItemTypes: ITEM_TYPES,
		Filters: 'IsUnplayed',
		Fields: 'Path,SeriesName,ImageTags'
	});
	return Items;
}

async function unwatchedItemsForPathFolder(viewId: string, folderName: string): Promise<JfItem[]> {
	const { userId } = config();
	const rootPath = await getItemPath(viewId);
	if (!rootPath) return [];

	const { Items } = await jf<{ Items: JfItem[] }>(`/Users/${userId}/Items`, {
		ParentId: viewId,
		Recursive: 'true',
		IncludeItemTypes: ITEM_TYPES,
		Filters: 'IsUnplayed',
		Fields: 'Path,SeriesName,ImageTags'
	});
	return Items.filter((item) => item.Path && folderUnderRoot(item.Path, rootPath) === folderName);
}

async function unwatchedItemsForFolder(folderId: string): Promise<JfItem[]> {
	if (folderId.startsWith('path:')) {
		const [, viewId, encodedName] = folderId.split(':');
		return unwatchedItemsForPathFolder(viewId, decodeURIComponent(encodedName));
	}
	return unwatchedItemsForRealFolder(folderId);
}

function shuffle<T>(items: T[]): T[] {
	const copy = [...items];
	for (let i = copy.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[copy[i], copy[j]] = [copy[j], copy[i]];
	}
	return copy;
}

async function findExistingPlaylistId(): Promise<string | undefined> {
	const { userId } = config();
	const { Items } = await jf<{ Items: JfItem[] }>(`/Users/${userId}/Items`, {
		IncludeItemTypes: 'Playlist',
		Recursive: 'true',
		SearchTerm: PLAYLIST_NAME
	});
	return Items.find((item) => item.Name === PLAYLIST_NAME)?.Id;
}

export async function generateTodayPlaylist(
	folderIds: string[],
	count = 10
): Promise<{ playlistId: string; items: PlaylistItem[] }> {
	const { userId } = config();

	const pools = await Promise.all(folderIds.map(unwatchedItemsForFolder));
	const byId = new Map<string, JfItem>();
	for (const item of pools.flat()) byId.set(item.Id, item);

	const chosen = shuffle([...byId.values()]).slice(0, count);
	if (chosen.length === 0) {
		throw new Error('No se encontraron items sin ver en las carpetas seleccionadas');
	}

	const existingId = await findExistingPlaylistId();
	if (existingId) {
		await jf(`/Items/${existingId}`, {}, { method: 'DELETE' });
	}

	const created = await jf<{ Id: string }>(
		'/Playlists',
		{},
		{
			method: 'POST',
			body: JSON.stringify({
				Name: PLAYLIST_NAME,
				Ids: chosen.map((item) => item.Id),
				UserId: userId,
				MediaType: 'Video'
			})
		}
	);

	return {
		playlistId: created.Id,
		items: chosen.map((item) => ({
			id: item.Id,
			name: item.Name,
			seriesName: item.SeriesName,
			hasImage: Boolean(item.ImageTags?.Primary)
		}))
	};
}

export async function listSessions(): Promise<ClientSession[]> {
	const { userId } = config();
	const sessions = await jf<
		{ Id: string; DeviceName: string; Client: string; SupportsRemoteControl: boolean }[]
	>('/Sessions', { ControllableByUserId: userId });

	return sessions
		.filter((s) => s.SupportsRemoteControl)
		.map((s) => ({ id: s.Id, deviceName: s.DeviceName, client: s.Client }));
}

export async function playOnSession(sessionId: string, itemIds: string[]): Promise<void> {
	await jf(
		`/Sessions/${sessionId}/Playing`,
		{ PlayCommand: 'PlayNow', ItemIds: itemIds.join(',') },
		{ method: 'POST' }
	);
}

export async function imageUrl(itemId: string): Promise<string> {
	const { url, apiKey } = config();
	return `${url}/Items/${itemId}/Images/Primary?maxHeight=400&quality=90&api_key=${apiKey}`;
}
