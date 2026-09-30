import { json, error } from '@sveltejs/kit';
import { pickCandidateItems } from '$lib/server/jellyfin';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json().catch(() => null);
	const folderIds: unknown = body?.folderIds;
	// Por defecto se excluyen los ya vistos; solo un `false` explícito los incluye.
	const excludeWatched = body?.excludeWatched !== false;

	if (
		!Array.isArray(folderIds) ||
		folderIds.length === 0 ||
		!folderIds.every((f) => typeof f === 'string')
	) {
		error(400, 'Selecciona al menos una carpeta');
	}

	try {
		const items = await pickCandidateItems(folderIds, excludeWatched);
		return json({ items });
	} catch (err) {
		error(502, err instanceof Error ? err.message : 'Error hablando con Jellyfin');
	}
};
