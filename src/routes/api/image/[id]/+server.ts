import { error } from '@sveltejs/kit';
import { fetchImage } from '$lib/server/jellyfin';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params }) => {
	const res = await fetchImage(params.id).catch(() => null);
	if (!res) error(404, 'Imagen no encontrada');

	return new Response(res.body, {
		headers: {
			'Content-Type': res.headers.get('content-type') ?? 'image/jpeg',
			'Cache-Control': 'public, max-age=3600'
		}
	});
};
