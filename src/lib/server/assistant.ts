// Asistente por voz: transcribe lo que se ha dicho (OpenAI) y le pide a Claude
// que lo traduzca a una selección de carpetas y un modo, el mismo input que
// usan los botones de la página.
import Anthropic from '@anthropic-ai/sdk';
import { env } from '$env/dynamic/private';
import type { FolderOption } from '$lib/types';

const MODEL = 'claude-opus-5-5';
const STT_MODEL = 'gpt-4o-mini-transcribe';
const TIMEOUT_MS = 60_000;

const EXT_BY_CONTENT_TYPE: Record<string, string> = {
	'audio/webm': 'webm',
	'audio/ogg': 'ogg',
	'audio/wav': 'wav',
	'audio/mpeg': 'mp3',
	'audio/mp4': 'mp4'
};

export async function transcribe(
	audio: Blob,
	contentType: string,
	folders: FolderOption[]
): Promise<string> {
	if (!env.OPENAI_API_KEY) throw new Error('Falta OPENAI_API_KEY');

	const type = contentType.split(';')[0].trim().toLowerCase();
	const form = new FormData();
	form.append('file', audio, `audio.${EXT_BY_CONTENT_TYPE[type] ?? 'webm'}`);
	form.append('model', STT_MODEL);
	form.append('language', 'es');
	// Los nombres de las carpetas como pista, para que "Chicho Terremoto" o
	// "Conde Pátula" salgan bien escritos.
	form.append('prompt', folders.map((f) => f.name).join(', '));

	const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
		method: 'POST',
		headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}` },
		body: form,
		signal: AbortSignal.timeout(TIMEOUT_MS)
	});
	if (!res.ok) {
		console.error('[assistant] transcripción falló:', res.status, await res.text());
		throw new Error('No se ha podido transcribir el audio');
	}
	const { text } = (await res.json()) as { text: string };
	return text.trim();
}

export type AssistantChoice = {
	folderIds: string[];
	mode: 'random' | 'continue';
	excludeWatched: boolean;
};

const SYSTEM_PROMPT = `Ayudas a preparar la sesión de dibujos animados de hoy en un Jellyfin doméstico.
Recibes la lista de carpetas (cada una es una serie o colección) y lo que ha pedido el usuario por voz, transcrito (puede tener errores de transcripción).
Elige las carpetas que corresponden a lo que pide. Una petición genérica ("clásicos de Disney", "algo de los 80") puede corresponder a varias carpetas: elige todas las que encajen.
Usa solo ids de la lista. Si nada encaja, devuelve folder_ids vacío.
mode: "continue" solo si pide seguir por donde iba con una única serie ("sigue con...", "el siguiente de..."); si no, "random".
exclude_watched: true salvo que pida explícitamente incluir los ya vistos o repetir.`;

const OUTPUT_SCHEMA = {
	type: 'object',
	properties: {
		folder_ids: { type: 'array', items: { type: 'string' } },
		mode: { type: 'string', enum: ['random', 'continue'] },
		exclude_watched: { type: 'boolean' }
	},
	required: ['folder_ids', 'mode', 'exclude_watched'],
	additionalProperties: false
};

export async function chooseFolders(
	request: string,
	folders: FolderOption[]
): Promise<AssistantChoice> {
	if (!env.ANTHROPIC_API_KEY) throw new Error('Falta ANTHROPIC_API_KEY');
	const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

	const response = await anthropic.beta.messages.create({
		model: MODEL,
		max_tokens: 4096,
		betas: ['server-side-fallback-2026-07-01'],
		fallbacks: 'default',
		output_config: { effort: 'low', format: { type: 'json_schema', schema: OUTPUT_SCHEMA } },
		system: SYSTEM_PROMPT,
		messages: [
			{
				role: 'user',
				content: `Carpetas:\n${JSON.stringify(folders)}\n\nPetición: ${request}`
			}
		]
	});

	if (response.stop_reason === 'refusal') throw new Error('El asistente no ha querido responder');
	const text = response.content.find((b) => b.type === 'text')?.text;
	if (!text) throw new Error('El asistente no ha devuelto nada');

	const parsed = JSON.parse(text) as {
		folder_ids: string[];
		mode: 'random' | 'continue';
		exclude_watched: boolean;
	};
	// Nunca un id que no sea de la lista, por si acaso.
	const known = new Set(folders.map((f) => f.id));
	const folderIds = [...new Set(parsed.folder_ids)].filter((id) => known.has(id));
	return {
		folderIds,
		mode: parsed.mode === 'continue' && folderIds.length === 1 ? 'continue' : 'random',
		excludeWatched: parsed.exclude_watched
	};
}
