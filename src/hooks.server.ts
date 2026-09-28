import { redirect } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { AUTH_COOKIE, sessionToken } from '$lib/server/auth';
import type { Handle } from '@sveltejs/kit';

const PUBLIC_PATHS = new Set(['/login']);

export const handle: Handle = async ({ event, resolve }) => {
	const { pathname } = event.url;

	if (env.ADMIN_PASSWORD && !PUBLIC_PATHS.has(pathname)) {
		const cookie = event.cookies.get(AUTH_COOKIE);
		const authed = !!cookie && cookie === sessionToken(env.ADMIN_PASSWORD);

		if (!authed) {
			redirect(303, '/login');
		}
	}

	return resolve(event);
};
