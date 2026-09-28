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

type VirtualFolder = { ItemId: string; Locations: string[] };

/**
 * Rutas físicas reales configuradas para cada biblioteca (Name/ItemId/Locations).
 * A diferencia del campo `Path` de /Users/{id}/Views, esto siempre son las carpetas
 * tal y como las añadiste en Jellyfin, aunque una biblioteca tenga varias.
 */
async function getLibraryRoots(): Promise<Map<string, string[]>> {
	const virtualFolders = await jf<VirtualFolder[]>('/Library/VirtualFolders');
	const map = new Map<string, string[]>();
	for (const vf of virtualFolders) map.set(vf.ItemId, vf.Locations ?? []);
	return map;
}

export async function listFolders(): Promise<FolderOption[]> {
	const { userId } = config();
	const [views, libraryRoots] = await Promise.all([
		jf<{ Items: JfItem[] }>(`/Users/${userId}/Views`),
		getLibraryRoots()
	]);

	// Recogemos primero todas las carpetas "en bruto": puede haber nombres repetidos
	// si dos bibliotecas (o dos ubicaciones dentro de una) apuntan a contenido con el
	// mismo nombre visible (p.ej. la misma serie añadida dos veces).
	const raw: FolderOption[] = [];
	for (const view of views.Items) {
		const roots = libraryRoots.get(view.Id) ?? [];

		if (roots.length > 0) {
			// Miramos TODOS los items de la biblioteca a cualquier profundidad (no solo
			// el primer nivel): algunas series meten cada episodio en su propia
			// subcarpeta, así que solo el Path completo hasta la raíz física nos dice
			// de forma fiable cuál es la carpeta madre real, sin importar cuántos
			// niveles haya entre medias.
			const { Items } = await jf<{ Items: JfItem[] }>(`/Users/${userId}/Items`, {
				ParentId: view.Id,
				Recursive: 'true',
				IncludeItemTypes: ITEM_TYPES,
				Fields: 'Path'
			});

			const seen = new Set<string>();
			for (const item of Items) {
				if (!item.Path) continue;
				const root = roots.find((r) => folderUnderRoot(item.Path!, r) !== undefined);
				const name = root ? folderUnderRoot(item.Path, root) : undefined;
				if (!root || !name || seen.has(name)) continue;
				seen.add(name);
				const id = `path:${view.Id}:${encodeURIComponent(root)}:${encodeURIComponent(name)}`;
				raw.push({ id, name });
			}
			continue;
		}

		// Sin raíz física conocida para esta biblioteca (p.ej. una fuente remota):
		// como último recurso, usamos las carpetas que el propio Jellyfin exponga.
		const children = await jf<{ Items: JfItem[] }>(`/Users/${userId}/Items`, {
			ParentId: view.Id,
			Recursive: 'false',
			Fields: 'Path'
		});
		for (const folder of children.Items.filter((c) => c.IsFolder)) {
			raw.push({ id: folder.Id, name: folder.Name });
		}
	}

	// Un único checkbox por nombre: si el mismo nombre viene de varias fuentes,
	// se fusionan en un id "multi:" que al seleccionarlo consulta todas ellas.
	const byName = new Map<string, string[]>();
	for (const folder of raw) {
		const ids = byName.get(folder.name) ?? [];
		ids.push(folder.id);
		byName.set(folder.name, ids);
	}

	return [...byName.entries()].map(([name, ids]) => ({
		name,
		id: ids.length === 1 ? ids[0] : `multi:${encodeURIComponent(JSON.stringify(ids))}`
	}));
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

async function unwatchedItemsForPathFolder(
	viewId: string,
	root: string,
	folderName: string
): Promise<JfItem[]> {
	const { userId } = config();
	const { Items } = await jf<{ Items: JfItem[] }>(`/Users/${userId}/Items`, {
		ParentId: viewId,
		Recursive: 'true',
		IncludeItemTypes: ITEM_TYPES,
		Filters: 'IsUnplayed',
		Fields: 'Path,SeriesName,ImageTags'
	});
	return Items.filter((item) => item.Path && folderUnderRoot(item.Path, root) === folderName);
}

async function unwatchedItemsForFolder(folderId: string): Promise<JfItem[]> {
	if (folderId.startsWith('multi:')) {
		const ids: string[] = JSON.parse(decodeURIComponent(folderId.slice('multi:'.length)));
		const pools = await Promise.all(ids.map(unwatchedItemsForFolder));
		return pools.flat();
	}
	if (folderId.startsWith('path:')) {
		const [, viewId, encodedRoot, encodedName] = folderId.split(':');
		return unwatchedItemsForPathFolder(
			viewId,
			decodeURIComponent(encodedRoot),
			decodeURIComponent(encodedName)
		);
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
