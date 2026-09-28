import { createHash, timingSafeEqual } from 'node:crypto';

export const AUTH_COOKIE = 'auth_token';

// Derivado de la contraseña en vez de guardarla tal cual, para que la
// contraseña en claro no acabe en una cookie aunque sea httpOnly.
export function sessionToken(password: string): string {
	return createHash('sha256').update(password).digest('hex');
}

export function passwordMatches(input: string, expected: string): boolean {
	const a = Buffer.from(input);
	const b = Buffer.from(expected);
	if (a.length !== b.length) return false;
	return timingSafeEqual(a, b);
}
