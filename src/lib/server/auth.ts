import { createHmac, scryptSync, timingSafeEqual } from 'node:crypto';
import type { Cookies } from '@sveltejs/kit';

export const AUTH_COOKIE = 'auth_token';

// Caduca tras 30 días sin usar la app; cada visita la renueva (como mucho una
// vez al día), así que en la práctica sigues dentro mientras la uses.
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const SESSION_RENEW_AFTER_MS = 24 * 60 * 60 * 1000;

// La cookie es `<emitida en ms>.<hmac>`: no contiene la contraseña ni un hash
// suyo. La clave del HMAC sale de la contraseña con scrypt, así que cambiar
// ADMIN_PASSWORD invalida todas las sesiones, y sacar la contraseña a partir
// de una cookie robada obliga a pagar scrypt por cada intento.
let cachedKey: { password: string; key: Buffer } | undefined;

function signingKey(password: string): Buffer {
	if (cachedKey?.password !== password) {
		cachedKey = { password, key: scryptSync(password, 'cartoons-session-v1', 32) };
	}
	return cachedKey.key;
}

function sign(issuedAt: string, password: string): string {
	return createHmac('sha256', signingKey(password)).update(issuedAt).digest('hex');
}

function safeEqual(a: string, b: string): boolean {
	const bufA = Buffer.from(a);
	const bufB = Buffer.from(b);
	return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

export function passwordMatches(input: string, expected: string): boolean {
	return safeEqual(input, expected);
}

export function setSessionCookie(cookies: Cookies, password: string, now = Date.now()): void {
	const issuedAt = String(now);
	cookies.set(AUTH_COOKIE, `${issuedAt}.${sign(issuedAt, password)}`, {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		maxAge: SESSION_MAX_AGE_MS / 1000
	});
}

/** Comprueba la cookie de sesión y la renueva si ya tiene más de un día. */
export function checkSession(cookies: Cookies, password: string, now = Date.now()): boolean {
	const [issuedAt, signature, ...rest] = (cookies.get(AUTH_COOKIE) ?? '').split('.');
	if (!issuedAt || !signature || rest.length > 0) return false;
	if (!safeEqual(signature, sign(issuedAt, password))) return false;

	const age = now - Number(issuedAt);
	if (!(age >= 0 && age < SESSION_MAX_AGE_MS)) return false;

	if (age > SESSION_RENEW_AFTER_MS) setSessionCookie(cookies, password, now);
	return true;
}

// ─── Límite de intentos de login ────────────────────────────────────────────
// En memoria: un solo contenedor, y reiniciarlo vacía los contadores, lo cual
// está bien. Va por IP, pero detrás de un proxy todas las peticiones llegan con
// la IP del proxy salvo que se configure ADDRESS_HEADER (ver README); en ese
// caso el límite es global, y bloquearía también tus intentos — aunque no las
// sesiones ya abiertas, que no pasan por el login.

const MAX_FAILURES = 5;
const FAILURE_WINDOW_MS = 15 * 60 * 1000;
const MAX_TRACKED = 10_000;

const failures = new Map<string, { count: number; firstAt: number }>();

/** Milisegundos que le quedan de bloqueo a `key`, o 0 si puede intentarlo. */
export function loginBlockedFor(key: string, now = Date.now()): number {
	const entry = failures.get(key);
	if (!entry) return 0;
	const remaining = entry.firstAt + FAILURE_WINDOW_MS - now;
	if (remaining <= 0) {
		failures.delete(key);
		return 0;
	}
	return entry.count >= MAX_FAILURES ? remaining : 0;
}

export function recordLoginFailure(key: string, now = Date.now()): void {
	const entry = failures.get(key);
	if (entry && now - entry.firstAt < FAILURE_WINDOW_MS) {
		entry.count++;
		return;
	}
	if (failures.size >= MAX_TRACKED) {
		for (const [k, e] of failures) {
			if (now - e.firstAt >= FAILURE_WINDOW_MS) failures.delete(k);
		}
		// Si aun así está lleno, lo más probable es un ataque desde muchas IPs:
		// se descarta la entrada más antigua para no crecer sin límite.
		if (failures.size >= MAX_TRACKED) failures.delete(failures.keys().next().value!);
	}
	failures.set(key, { count: 1, firstAt: now });
}

export function clearLoginFailures(key: string): void {
	failures.delete(key);
}
