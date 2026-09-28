import { fail, redirect } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { AUTH_COOKIE, passwordMatches, sessionToken } from '$lib/server/auth';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ cookies }) => {
	if (env.ADMIN_PASSWORD && cookies.get(AUTH_COOKIE) === sessionToken(env.ADMIN_PASSWORD)) {
		redirect(303, '/');
	}
};

export const actions: Actions = {
	default: async ({ request, cookies }) => {
		if (!env.ADMIN_PASSWORD) {
			return fail(500, { error: 'ADMIN_PASSWORD no está configurada en el servidor' });
		}

		const data = await request.formData();
		const password = String(data.get('password') ?? '');

		if (!passwordMatches(password, env.ADMIN_PASSWORD)) {
			return fail(401, { error: 'Contraseña incorrecta' });
		}

		// Sin maxAge sería una cookie de sesión (se borra al cerrar el navegador)
		// — 10 años la deja recordada indefinidamente.
		cookies.set(AUTH_COOKIE, sessionToken(env.ADMIN_PASSWORD), {
			path: '/',
			httpOnly: true,
			sameSite: 'lax',
			maxAge: 60 * 60 * 24 * 365 * 10
		});

		redirect(303, '/');
	}
};
