import { redirect } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { checkSession } from '$lib/server/auth';
import type { Handle } from '@sveltejs/kit';

const PUBLIC_PATHS = new Set(['/login']);

export const handle: Handle = async ({ event, resolve }) => {
	const { pathname } = event.url;

	if (env.ADMIN_PASSWORD && !PUBLIC_PATHS.has(pathname)) {
		if (!checkSession(event.cookies, env.ADMIN_PASSWORD)) {
			redirect(303, '/login');
		}
	}

	return resolve(event);
};
