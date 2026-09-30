import { json, error, isHttpError } from '@sveltejs/kit';
import { chooseSegments, transcribe, type AssistantSegment } from '$lib/server/assistant';
import { listFolders, nextItemsInFolder, pickCandidateItems } from '$lib/server/jellyfin';
import type { PlaylistItem } from '$lib/types';
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

		const segments = await chooseSegments(transcript, folders);
		const folderIds = [...new Set(segments.flatMap((s) => s.folderIds))];
		const excludeWatched = segments.every((s) => s.excludeWatched);

		// Los bloques se resuelven en orden y se concatenan; un bloque sin items
		// no tira la petición entera, solo deja un aviso.
		const items: PlaylistItem[] = [];
		const warnings: string[] = [];
		const seen = new Set<string>();
		for (const segment of segments) {
			try {
				const found = await resolveSegment(segment, seen);
				for (const item of found) seen.add(item.id);
				items.push(...found);
			} catch (err) {
				warnings.push(err instanceof Error ? err.message : 'Un bloque no ha dado resultados');
			}
		}

		return json({ transcript, folderIds, excludeWatched, segments, items, warnings });
	} catch (err) {
		if (isHttpError(err)) throw err;
		error(502, err instanceof Error ? err.message : 'Error en el asistente');
	}
};

async function resolveSegment(
	{ folderIds, mode, count, excludeWatched }: AssistantSegment,
	seen: Set<string>
): Promise<PlaylistItem[]> {
	if (mode === 'continue') {
		// Pide de más por si un bloque anterior ya cogió episodios de la misma serie.
		const next = await nextItemsInFolder(folderIds[0], count + seen.size);
		return next.filter((i) => !seen.has(i.id)).slice(0, count);
	}
	// Con pocas carpetas, que el reparto no se quede corto por el tope por carpeta.
	const maxPerFolder = Math.max(2, Math.ceil(count / folderIds.length)) + seen.size;
	const picked = await pickCandidateItems(
		folderIds,
		excludeWatched,
		count + seen.size,
		maxPerFolder
	);
	return picked.filter((i) => !seen.has(i.id)).slice(0, count);
}
