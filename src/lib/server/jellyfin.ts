import { env } from '$env/dynamic/private';
import type { ClientSession, FolderOption, PlaylistItem } from '$lib/types';

const PLAYLIST_NAME = 'Para ver hoy';
const ITEM_TYPES = 'Movie,Episode,Video';

type JfItem = {
	Id: string;
	Name: string;
	SeriesName?: string;
	ImageTags?: Record<string, string>;
};

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
 * En este Jellyfin cada biblioteca (View) es directamente una serie/colección
 * (una carpeta madre), no una biblioteca grande con varias series dentro. Así
 * que la carpeta a elegir es la propia View, sin bajar a mirar su contenido.
 */
export async function listFolders(): Promise<FolderOption[]> {
	const { userId } = config();
	const { Items } = await jf<{ Items: JfItem[] }>(`/Users/${userId}/Views`);

	// Un único checkbox por nombre: si dos bibliotecas comparten nombre (p.ej.
	// añadida por error dos veces), se fusionan en un id "multi:" que al
	// seleccionarlo consulta items sin ver en todas ellas.
	const byName = new Map<string, string[]>();
	for (const view of Items) {
		const ids = byName.get(view.Name) ?? [];
		ids.push(view.Id);
		byName.set(view.Name, ids);
	}

	return [...byName.entries()].map(([name, ids]) => ({
		name,
		id: ids.length === 1 ? ids[0] : `multi:${encodeURIComponent(JSON.stringify(ids))}`
	}));
}

async function unwatchedItemsForFolder(folderId: string): Promise<JfItem[]> {
	if (folderId.startsWith('multi:')) {
		const ids: string[] = JSON.parse(decodeURIComponent(folderId.slice('multi:'.length)));
		const pools = await Promise.all(ids.map(unwatchedItemsForFolder));
		return pools.flat();
	}

	const { userId } = config();
	const { Items } = await jf<{ Items: JfItem[] }>(`/Users/${userId}/Items`, {
		ParentId: folderId,
		Recursive: 'true',
		IncludeItemTypes: ITEM_TYPES,
		Filters: 'IsUnplayed',
		Fields: 'SeriesName,ImageTags'
	});
	return Items;
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
