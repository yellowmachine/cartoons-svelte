import { json, error } from '@sveltejs/kit';
import { nextItemsInFolder, pickCandidateItems } from '$lib/server/jellyfin';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json().catch(() => null);
	const folderIds: unknown = body?.folderIds;
	const mode = body?.mode === 'continue' ? 'continue' : 'random';
	// Por defecto se excluyen los ya vistos; solo un `false` explícito los incluye.
	const excludeWatched = body?.excludeWatched !== false;

	if (
		!Array.isArray(folderIds) ||
		folderIds.length === 0 ||
		!folderIds.every((f) => typeof f === 'string')
	) {
		error(400, 'Selecciona al menos una carpeta');
	}
	if (mode === 'continue' && folderIds.length !== 1) {
		error(400, 'Para continuar, selecciona una sola carpeta');
	}

	try {
		const items =
			mode === 'continue'
				? await nextItemsInFolder(folderIds[0])
				: await pickCandidateItems(folderIds, excludeWatched);
		return json({ items });
	} catch (err) {
		error(502, err instanceof Error ? err.message : 'Error hablando con Jellyfin');
	}
};
