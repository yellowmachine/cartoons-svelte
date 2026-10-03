import { fail, redirect } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import {
	checkSession,
	clearLoginFailures,
	loginBlockedFor,
	passwordMatches,
	recordLoginFailure,
	setSessionCookie
} from '$lib/server/auth';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ cookies }) => {
	if (env.ADMIN_PASSWORD && checkSession(cookies, env.ADMIN_PASSWORD)) {
		redirect(303, '/');
	}
};

export const actions: Actions = {
	default: async ({ request, cookies, getClientAddress }) => {
		if (!env.ADMIN_PASSWORD) {
			return fail(500, { error: 'ADMIN_PASSWORD no está configurada en el servidor' });
		}

		// Con ADDRESS_HEADER configurado, el adaptador lanza si falta la
		// cabecera; mejor agrupar esas peticiones que romper el login.
		let client: string;
		try {
			client = getClientAddress();
		} catch {
			client = 'unknown';
		}

		const blockedMs = loginBlockedFor(client);
		if (blockedMs > 0) {
			const minutes = Math.ceil(blockedMs / 60_000);
			return fail(429, {
				error: `Demasiados intentos. Prueba de nuevo en ${minutes} min.`
			});
		}

		const data = await request.formData();
		const password = String(data.get('password') ?? '');

		if (!passwordMatches(password, env.ADMIN_PASSWORD)) {
			recordLoginFailure(client);
			return fail(401, { error: 'Contraseña incorrecta' });
		}

		clearLoginFailures(client);
		setSessionCookie(cookies, env.ADMIN_PASSWORD);
		redirect(303, '/');
	}
};
