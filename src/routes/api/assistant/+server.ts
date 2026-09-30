import { json, error, isHttpError } from '@sveltejs/kit';
import { chooseFolders, transcribe } from '$lib/server/assistant';
import { listFolders, nextItemsInFolder, pickCandidateItems } from '$lib/server/jellyfin';
import type { RequestHandler } from './$types';

/** Recibe el audio grabado en el navegador y devuelve la lista candidata. */
export const POST: RequestHandler = async ({ request }) => {
	const audio = await request.blob();
	if (audio.size === 0) error(400, 'No se ha recibido audio');

	try {
		const folders = await listFolders();
		const transcript = await transcribe(
			audio,
			request.headers.get('content-type') ?? 'audio/webm',
			folders
		);
		if (!transcript) error(400, 'No se ha entendido nada, prueba otra vez');

		const choice = await chooseFolders(transcript, folders);
		if (choice.folderIds.length === 0) {
			return json({ transcript, ...choice, items: [] });
		}

		const items =
			choice.mode === 'continue'
				? await nextItemsInFolder(choice.folderIds[0])
				: await pickCandidateItems(choice.folderIds, choice.excludeWatched);
		return json({ transcript, ...choice, items });
	} catch (err) {
		if (isHttpError(err)) throw err;
		error(502, err instanceof Error ? err.message : 'Error en el asistente');
	}
};
