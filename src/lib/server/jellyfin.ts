// Acceso a Jellyfin a través de jellyfin-bridge, el servicio que corre en casa
// junto a Jellyfin (ver jellyfin-bridge/README.md). La app nunca ve la API key
// de Jellyfin: solo el token del bridge.
import { env } from '$env/dynamic/private';
import type { ClientSession, FolderOption, PlaylistItem } from '$lib/types';

const TIMEOUT_MS = 30_000;

/** Un item tal y como lo devuelve el bridge (`GET /folders/{id}/items`). */
type BridgeItem = {
	id: string;
	name: string;
	series_name?: string;
	sort_name?: string;
	/** Número de temporada (en episodios). */
	season?: number;
	/** Número de episodio dentro de la temporada. */
	episode?: number;
	has_image: boolean;
};

function baseUrl(): string {
	const url = env.JELLYFIN_BRIDGE_URL;
	if (!url || !env.JELLYFIN_BRIDGE_TOKEN) {
		throw new Error(
			'Faltan variables de entorno del bridge: JELLYFIN_BRIDGE_URL, JELLYFIN_BRIDGE_TOKEN'
		);
	}
	return url.replace(/\/+$/, '');
}

function authHeaders(): Record<string, string> {
	const headers: Record<string, string> = {
		Authorization: `Bearer ${env.JELLYFIN_BRIDGE_TOKEN}`
	};
	// Service token de Cloudflare Access, cuando el bridge está detrás de un túnel.
	if (env.CF_ACCESS_CLIENT_ID && env.CF_ACCESS_CLIENT_SECRET) {
		headers['CF-Access-Client-Id'] = env.CF_ACCESS_CLIENT_ID;
		headers['CF-Access-Client-Secret'] = env.CF_ACCESS_CLIENT_SECRET;
	}
	return headers;
}

/** Hace la petición al bridge y lanza un Error legible si no sale bien. */
async function send(method: string, path: string, body?: unknown): Promise<Response> {
	const headers = authHeaders();
	if (body !== undefined) headers['Content-Type'] = 'application/json';

	let res: Response;
	try {
		res = await fetch(baseUrl() + path, {
			method,
			headers,
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: AbortSignal.timeout(TIMEOUT_MS),
			// Cloudflare Access responde a un service token rechazado con una
			// redirección a su login; seguirla escondería el fallo.
			redirect: 'manual'
		});
	} catch (err) {
		console.error(`[bridge] ${method} ${path} falló:`, err);
		throw new Error('No se puede contactar con jellyfin-bridge', { cause: err });
	}

	if (res.ok) return res;

	if (res.status >= 300 && res.status < 400) {
		console.error(`[bridge] ${method} ${path}: redirección (¿Cloudflare Access rechaza el token?)`);
		throw new Error('Cloudflare Access rechazó la petición al bridge');
	}
	if (res.status === 401) {
		console.error('[bridge] 401: JELLYFIN_BRIDGE_TOKEN no coincide con el API_TOKEN del bridge');
	}
	let message = res.statusText;
	try {
		message = ((await res.json()) as { error?: string }).error ?? message;
	} catch {
		// no es JSON (p.ej. una página de error del túnel)
	}
	throw new Error(`jellyfin-bridge ${method} ${path} respondió ${res.status}: ${message}`);
}

async function bridge<T>(method: string, path: string, body?: unknown): Promise<T> {
	const res = await send(method, path, body);
	return (res.status === 204 ? undefined : await res.json()) as T;
}

const seg = encodeURIComponent;

/**
 * En este Jellyfin cada biblioteca (View) es directamente una serie/colección
 * (una carpeta madre), no una biblioteca grande con varias series dentro. Así
 * que la carpeta a elegir es la propia View, sin bajar a mirar su contenido.
 */
export async function listFolders(): Promise<FolderOption[]> {
	const views = await bridge<{ id: string; name: string }[]>('GET', '/folders');

	// Un único checkbox por nombre: si dos bibliotecas comparten nombre (p.ej.
	// añadida por error dos veces), se fusionan en un id "multi:" que al
	// seleccionarlo consulta items sin ver en todas ellas.
	const byName = new Map<string, string[]>();
	for (const view of views) {
		const ids = byName.get(view.name) ?? [];
		ids.push(view.id);
		byName.set(view.name, ids);
	}

	return [...byName.entries()].map(([name, ids]) => ({
		name,
		id: ids.length === 1 ? ids[0] : `multi:${encodeURIComponent(JSON.stringify(ids))}`
	}));
}

async function itemsForFolder(folderId: string, excludeWatched: boolean): Promise<BridgeItem[]> {
	if (folderId.startsWith('multi:')) {
		const ids: string[] = JSON.parse(decodeURIComponent(folderId.slice('multi:'.length)));
		const pools = await Promise.all(ids.map((id) => itemsForFolder(id, excludeWatched)));
		return pools.flat();
	}

	return bridge<BridgeItem[]>('GET', `/folders/${seg(folderId)}/items?unplayed=${excludeWatched}`);
}

function shuffle<T>(items: T[]): T[] {
	const copy = [...items];
	for (let i = copy.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[copy[i], copy[j]] = [copy[j], copy[i]];
	}
	return copy;
}

function toPlaylistItem(item: BridgeItem): PlaylistItem {
	return {
		id: item.id,
		name: item.name,
		seriesName: item.series_name,
		hasImage: item.has_image
	};
}

export async function pickCandidateItems(
	folderIds: string[],
	excludeWatched = true,
	count = 10,
	maxPerFolder = 2
): Promise<PlaylistItem[]> {
	// Como mucho `maxPerFolder` items por carpeta, aunque el total no llegue a `count`
	// — si no, una carpeta con muchísimo contenido se comería todo el resultado.
	const pools = await Promise.all(folderIds.map((id) => itemsForFolder(id, excludeWatched)));
	const seenIds = new Set<string>();
	const capped: BridgeItem[] = [];
	for (const pool of pools) {
		let taken = 0;
		for (const item of shuffle(pool)) {
			if (taken >= maxPerFolder) break;
			if (seenIds.has(item.id)) continue;
			seenIds.add(item.id);
			capped.push(item);
			taken++;
		}
	}

	const chosen = shuffle(capped).slice(0, count);
	if (chosen.length === 0) {
		throw new Error(
			excludeWatched
				? 'No se encontraron items sin ver en las carpetas seleccionadas'
				: 'No se encontraron items en las carpetas seleccionadas'
		);
	}
	return chosen.map(toPlaylistItem);
}

/** Temporada, episodio y nombre; lo que no tenga numeración va al final. */
function compareEpisodeOrder(a: BridgeItem, b: BridgeItem): number {
	const season = (a.season ?? Infinity) - (b.season ?? Infinity);
	if (season) return season;
	const episode = (a.episode ?? Infinity) - (b.episode ?? Infinity);
	if (episode) return episode;
	return (a.sort_name ?? a.name).localeCompare(b.sort_name ?? b.name, undefined, {
		numeric: true
	});
}

/**
 * Los siguientes `count` items sin ver de una carpeta, en orden. Se ordena aquí
 * y no en Jellyfin porque las carpetas "multi:" juntan varias bibliotecas.
 */
export async function nextItemsInFolder(folderId: string, count = 10): Promise<PlaylistItem[]> {
	const pool = await itemsForFolder(folderId, true);
	const chosen = pool.sort(compareEpisodeOrder).slice(0, count);
	if (chosen.length === 0) {
		throw new Error('No quedan items sin ver en esa carpeta');
	}
	return chosen.map(toPlaylistItem);
}

/** Borra la playlist "Para ver hoy" si existe y crea una nueva con `itemIds`. */
export async function createTodayPlaylist(itemIds: string[]): Promise<{ playlistId: string }> {
	if (itemIds.length === 0) {
		throw new Error('No hay items seleccionados para la playlist');
	}
	const { id } = await bridge<{ id: string }>('PUT', '/playlist', { item_ids: itemIds });
	return { playlistId: id };
}

export async function listSessions(): Promise<ClientSession[]> {
	const sessions = await bridge<{ id: string; device_name: string; client: string }[]>(
		'GET',
		'/sessions'
	);
	return sessions.map((s) => ({ id: s.id, deviceName: s.device_name, client: s.client }));
}

export async function playOnSession(sessionId: string, itemIds: string[]): Promise<void> {
	await bridge('POST', `/sessions/${seg(sessionId)}/play`, { item_ids: itemIds });
}

/** La imagen principal de un item, tal cual la sirve el bridge. */
export async function fetchImage(itemId: string): Promise<Response> {
	return send('GET', `/items/${seg(itemId)}/image`);
}
