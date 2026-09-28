import { json, error } from '@sveltejs/kit';
import { playOnSession } from '$lib/server/jellyfin';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json().catch(() => null);
	const sessionId: unknown = body?.sessionId;
	const itemIds: unknown = body?.itemIds;

	if (
		typeof sessionId !== 'string' ||
		!Array.isArray(itemIds) ||
		!itemIds.every((i) => typeof i === 'string')
	) {
		error(400, 'Faltan sessionId o itemIds');
	}

	try {
		await playOnSession(sessionId, itemIds);
		return json({ ok: true });
	} catch (err) {
		error(502, err instanceof Error ? err.message : 'Error hablando con Jellyfin');
	}
};
