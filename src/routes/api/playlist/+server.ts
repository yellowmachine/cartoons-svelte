import { json, error } from '@sveltejs/kit';
import { createTodayPlaylist, listSessions } from '$lib/server/jellyfin';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json().catch(() => null);
	const itemIds: unknown = body?.itemIds;

	if (
		!Array.isArray(itemIds) ||
		itemIds.length === 0 ||
		!itemIds.every((i) => typeof i === 'string')
	) {
		error(400, 'Selecciona al menos un item');
	}

	try {
		const [{ playlistId }, sessions] = await Promise.all([
			createTodayPlaylist(itemIds),
			listSessions()
		]);
		return json({ playlistId, sessions });
	} catch (err) {
		error(502, err instanceof Error ? err.message : 'Error hablando con Jellyfin');
	}
};
