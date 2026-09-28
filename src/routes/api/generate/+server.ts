import { json, error } from '@sveltejs/kit';
import { generateTodayPlaylist, listSessions } from '$lib/server/jellyfin';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json().catch(() => null);
	const folderIds: unknown = body?.folderIds;

	if (
		!Array.isArray(folderIds) ||
		folderIds.length === 0 ||
		!folderIds.every((f) => typeof f === 'string')
	) {
		error(400, 'Selecciona al menos una carpeta');
	}

	try {
		const [{ playlistId, items }, sessions] = await Promise.all([
			generateTodayPlaylist(folderIds),
			listSessions()
		]);
		return json({ playlistId, items, sessions });
	} catch (err) {
		error(502, err instanceof Error ? err.message : 'Error hablando con Jellyfin');
	}
};
