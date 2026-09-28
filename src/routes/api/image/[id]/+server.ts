import { error } from '@sveltejs/kit';
import { imageUrl } from '$lib/server/jellyfin';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params, fetch }) => {
	const src = await imageUrl(params.id);
	const res = await fetch(src);
	if (!res.ok) error(404, 'Imagen no encontrada');

	return new Response(res.body, {
		headers: {
			'Content-Type': res.headers.get('content-type') ?? 'image/jpeg',
			'Cache-Control': 'public, max-age=3600'
		}
	});
};
