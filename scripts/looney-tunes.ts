// Identifica los cortos de Looney Tunes rippeados de los DVD (ficheros tipo
// "C3_t05.mkv") leyendo el cartel del título con Claude, los cruza con la
// filmografía de Wikipedia y los coloca como serie para Jellyfin:
//
//   Looney Tunes/Season 1954/Looney Tunes - S1954E18 - Bewitched Bunny.mkv (+ .nfo)
//
// Dos pasos, para poder revisar antes de tocar nada:
//   bun scripts/looney-tunes.ts plan  [origen]   → escribe .cache/looney-tunes/plan.csv
//   bun scripts/looney-tunes.ts apply [origen]   → mueve lo que tenga action=move
//
// En el CSV se puede cambiar `action`, o `season`/`episode` para corregir un
// emparejamiento: `apply` recalcula el destino y el .nfo a partir de ellos.
import Anthropic from '@anthropic-ai/sdk';
import { mkdir, readdir, rename, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';

const DEFAULT_SOURCE = '/home/miguel/salon/looney tunes';
const SERIES = 'Looney Tunes';
const WORK = join(import.meta.dir, '..', '.cache', 'looney-tunes');
const MODEL = 'claude-opus-5-5';
const CONCURRENCY = 4;
const USER_AGENT = 'cartoons-svelte-scripts/1.0';
const WIKI_PAGES = [
	'Looney Tunes and Merrie Melodies filmography (1930–1939)',
	'Looney Tunes and Merrie Melodies filmography (1940–1949)',
	'Looney Tunes and Merrie Melodies filmography (1950–1959)',
	'Looney Tunes and Merrie Melodies filmography (1960–1969)'
];

// Duraciones, en segundos, para separar cortos de extras y del "reproducir todo".
const SHORT_MIN = 4 * 60;
const SHORT_MAX = 11 * 60;
const EXTRA_MAX = 30 * 60;

type Kind = 'short' | 'extra' | 'playall' | 'clip';
type Action = 'move' | 'review' | 'duplicate' | 'extra' | 'skip';

type Reading = {
	is_title_card: boolean;
	title: string | null;
	director: string | null;
	copyright_year: number | null;
	confidence: 'high' | 'medium' | 'low';
	notes: string;
};

type WikiShort = {
	title: string;
	season: number;
	episode: number;
	date: string;
	banner: string;
	director: string;
	plot: string;
};

type Row = {
	action: Action;
	src: string;
	minutes: string;
	kind: Kind;
	read_title: string;
	read_director: string;
	read_year: string;
	confidence: string;
	wiki_title: string;
	release_date: string;
	season: string;
	episode: string;
	dest: string;
	notes: string;
};

const COLUMNS: (keyof Row)[] = [
	'action',
	'src',
	'minutes',
	'kind',
	'read_title',
	'read_director',
	'read_year',
	'confidence',
	'wiki_title',
	'release_date',
	'season',
	'episode',
	'dest',
	'notes'
];

// ---------------------------------------------------------------- ficheros

async function findVideos(dir: string, skip: string): Promise<string[]> {
	const out: string[] = [];
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (path !== skip) out.push(...(await findVideos(path, skip)));
		} else if (entry.name.toLowerCase().endsWith('.mkv')) {
			out.push(path);
		}
	}
	return out.sort();
}

async function run(cmd: string[]): Promise<string> {
	const proc = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe' });
	const [out, err, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited
	]);
	if (code !== 0) throw new Error(`${cmd[0]} falló: ${err.trim()}`);
	return out;
}

async function duration(file: string): Promise<number> {
	const out = await run([
		'ffprobe',
		'-v',
		'error',
		'-show_entries',
		'format=duration',
		'-of',
		'csv=p=0',
		file
	]);
	return parseFloat(out);
}

function kindOf(seconds: number): Kind {
	if (seconds < SHORT_MIN) return 'clip';
	if (seconds <= SHORT_MAX) return 'short';
	if (seconds <= EXTRA_MAX) return 'extra';
	return 'playall';
}

/** Nombre estable para la caché de cada fichero. */
function cacheKey(rel: string): string {
	return new Bun.CryptoHasher('sha1').update(rel).digest('hex').slice(0, 16);
}

/** 16 fotogramas del segundo 4 al 49, en una cuadrícula 4x4 con el tiempo marcado. */
async function titleGrid(file: string, out: string): Promise<void> {
	if (existsSync(out)) return;
	const tmp = `${out}.frames`;
	await mkdir(tmp, { recursive: true });
	for (let i = 0; i < 16; i++) {
		const t = 4 + i * 3;
		await run([
			'ffmpeg',
			'-v',
			'error',
			'-y',
			'-ss',
			String(t),
			'-i',
			file,
			'-frames:v',
			'1',
			'-strict',
			'unofficial',
			'-vf',
			`scale=320:240,drawtext=text='${t} s':x=5:y=5:fontsize=18:fontcolor=white:box=1:boxcolor=black`,
			join(tmp, `${String(i).padStart(2, '0')}.jpg`)
		]);
	}
	await run([
		'ffmpeg',
		'-v',
		'error',
		'-y',
		'-framerate',
		'1',
		'-i',
		join(tmp, '%02d.jpg'),
		'-vf',
		'tile=4x4',
		'-frames:v',
		'1',
		'-strict',
		'unofficial',
		out
	]);
	await run(['rm', '-r', tmp]);
}

// ---------------------------------------------------------------- Claude

const READ_PROMPT = `La imagen son 16 fotogramas, en orden, de los primeros 50 segundos de un corto clásico de Warner Bros. (Looney Tunes o Merrie Melodies), rippeado de un DVD.
Lee el cartel con el título del corto (no el logo de la serie ni el de Warner) y, si aparecen, el director ("Directed by", "Supervision") y el año del copyright en números romanos del logo de Warner.
Si no ves un cartel de título de un corto (es un extra, un documental, un menú…), is_title_card = false.
Escribe el título tal cual aparece, sin comillas. confidence: high si se lee claramente; low si lo estás deduciendo.`;

const READ_SCHEMA = {
	type: 'object',
	properties: {
		is_title_card: { type: 'boolean' },
		title: { type: ['string', 'null'] },
		director: { type: ['string', 'null'] },
		copyright_year: { type: ['integer', 'null'] },
		confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
		notes: { type: 'string' }
	},
	required: ['is_title_card', 'title', 'director', 'copyright_year', 'confidence', 'notes'],
	additionalProperties: false
};

async function readTitleCard(anthropic: Anthropic, grid: string): Promise<Reading> {
	const data = Buffer.from(await Bun.file(grid).arrayBuffer()).toString('base64');
	const response = await anthropic.beta.messages.create({
		model: MODEL,
		max_tokens: 2048,
		output_config: { effort: 'low', format: { type: 'json_schema', schema: READ_SCHEMA } },
		messages: [
			{
				role: 'user',
				content: [
					{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } },
					{ type: 'text', text: READ_PROMPT }
				]
			}
		]
	});
	const text = response.content.find((b) => b.type === 'text')?.text;
	if (!text) throw new Error(`Claude no ha devuelto nada (${response.stop_reason})`);
	return JSON.parse(text) as Reading;
}

// ---------------------------------------------------------------- Wikipedia

async function wikitext(page: string): Promise<string> {
	const cache = join(WORK, 'wiki', `${cacheKey(page)}.txt`);
	if (existsSync(cache)) return Bun.file(cache).text();
	const url = new URL('https://en.wikipedia.org/w/api.php');
	url.search = new URLSearchParams({
		action: 'parse',
		page,
		prop: 'wikitext',
		format: 'json',
		formatversion: '2'
	}).toString();
	const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
	if (!res.ok) throw new Error(`Wikipedia ${res.status} en ${page}`);
	const text = ((await res.json()) as { parse: { wikitext: string } }).parse.wikitext;
	await Bun.write(cache, text);
	return text;
}

/** Quita el marcado de wiki: enlaces, cursivas, refs, plantillas y HTML. */
function plain(s: string): string {
	return s
		.replace(/\{\{sort\|[^|]*\|([^{}]*)\}\}/gi, '$1')
		.replace(/<ref[^>]*\/>/g, '')
		.replace(/<ref[\s\S]*?<\/ref>/g, '')
		.replace(/<br\s*\/?>/g, ', ')
		.replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, '$1')
		.replace(/\{\{[^{}]*\}\}/g, '')
		.replace(/<[^>]+>/g, '')
		.replace(/'{2,}/g, '')
		.replace(/\s+/g, ' ')
		.trim();
}

/**
 * Los campos de una plantilla, hasta su `}}`. Unas veces van uno por línea y
 * otras todos seguidos (`|A=1|B=2`), así que se parte por los `|` que no estén
 * dentro de otra plantilla o enlace.
 */
function templateFields(block: string): Record<string, string> {
	const parts: string[] = [];
	let braces = 0;
	let links = 0;
	let current = '';
	for (let i = 0; i < block.length; i++) {
		const two = block.slice(i, i + 2);
		if (two === '{{' || two === '[[' || two === ']]' || (two === '}}' && braces > 0)) {
			if (two === '{{') braces++;
			else if (two === '}}') braces--;
			else if (two === '[[') links++;
			else links--;
			current += two;
			i++;
		} else if (two === '}}') break;
		else if (block[i] === '|' && braces === 0 && links === 0) {
			parts.push(current);
			current = '';
		} else current += block[i];
	}
	parts.push(current);

	const fields: Record<string, string> = {};
	for (const part of parts) {
		const m = part.match(/^\s*(\w+)\s*=([\s\S]*)$/);
		if (m) fields[m[1]] = m[2].trim();
	}
	return fields;
}

function parseFilmography(text: string): WikiShort[] {
	const shorts: WikiShort[] = [];
	for (const block of text.split('{{#invoke:Episode list|list').slice(1)) {
		const fields = templateFields(block);
		const date = fields.OriginalAirDate?.match(/Start date\|(\d{4})\|(\d{1,2})\|(\d{1,2})/);
		const episode = parseInt(fields.EpisodeNumber2 ?? '');
		if (!fields.RTitle || !date || !episode) continue;
		shorts.push({
			title: plain(fields.RTitle),
			season: parseInt(date[1]),
			episode,
			date: `${date[1]}-${date[2].padStart(2, '0')}-${date[3].padStart(2, '0')}`,
			banner: plain(fields.Aux1 ?? ''),
			director: plain(fields.DirectedBy ?? ''),
			plot: plain(fields.ShortSummary ?? '')
		});
	}
	return shorts;
}

async function filmography(): Promise<WikiShort[]> {
	const all: WikiShort[] = [];
	for (const page of WIKI_PAGES) all.push(...parseFilmography(await wikitext(page)));
	return all;
}

// ---------------------------------------------------------------- emparejar

function normalize(s: string): string {
	return s
		.normalize('NFKD')
		.replace(/[̀-ͯ]/g, '')
		.toLowerCase()
		.replace(/&/g, 'and')
		.replace(/[^a-z0-9]+/g, ' ')
		.trim();
}

function similarity(a: string, b: string): number {
	if (a === b) return 1;
	const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
	for (let i = 1; i <= a.length; i++) {
		let diag = prev[0];
		prev[0] = i;
		for (let j = 1; j <= b.length; j++) {
			const tmp = prev[j];
			prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
			diag = tmp;
		}
	}
	return 1 - prev[b.length] / Math.max(a.length, b.length);
}

/**
 * Parecido entre dos títulos ya normalizados. Si uno contiene al otro cuenta
 * como casi igual: el cartel a veces añade algo ("Hollywood Capers featuring
 * Beans", "Page Miss Glory").
 */
function titleScore(read: string, wiki: string): number {
	const [short, long] = read.length < wiki.length ? [read, wiki] : [wiki, read];
	if (short !== long && short.length >= 8 && ` ${long} `.includes(` ${short} `)) return 0.9;
	return similarity(read, wiki);
}

/** El apellido del director aparece igual en el cartel y en Wikipedia ("Charles M. Jones" / "Chuck Jones"). */
function sameDirector(read: string | null, wiki: string): boolean {
	if (!read) return false;
	const surnames = normalize(read)
		.split(' ')
		.filter((w) => w.length > 3);
	const w = normalize(wiki);
	return surnames.some((s) => w.includes(s));
}

function match(reading: Reading, shorts: WikiShort[]): { short: WikiShort; exact: boolean } | null {
	if (!reading.title) return null;
	const title = normalize(reading.title);
	const scored = shorts
		.map((short) => ({ short, score: titleScore(title, normalize(short.title)) }))
		.filter((c) => c.score >= 0.8);
	if (scored.length === 0) return null;
	// Entre títulos iguales o casi, gana el del mismo director y el año más cercano al copyright.
	const rank = (c: { short: WikiShort; score: number }) =>
		c.score * 10 +
		(sameDirector(reading.director, c.short.director) ? 2 : 0) -
		(reading.copyright_year
			? Math.min(Math.abs(c.short.season - reading.copyright_year), 5) / 5
			: 0);
	const best = scored.sort((a, b) => rank(b) - rank(a))[0];
	return { short: best.short, exact: best.score === 1 };
}

function destFor(dest: string, short: WikiShort): string {
	const safe = short.title.replace(/[/\\:*?"<>|]/g, '').trim();
	const code = `S${short.season}E${String(short.episode).padStart(2, '0')}`;
	return join(dest, `Season ${short.season}`, `${SERIES} - ${code} - ${safe}.mkv`);
}

// ---------------------------------------------------------------- CSV

function toCsv(rows: Row[]): string {
	const cell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
	return [COLUMNS.join(','), ...rows.map((r) => COLUMNS.map((c) => cell(r[c])).join(','))].join(
		'\n'
	);
}

function fromCsv(text: string): Row[] {
	const records: string[][] = [];
	let field = '';
	let record: string[] = [];
	let quoted = false;
	const endField = () => {
		record.push(field);
		field = '';
	};
	const endRecord = () => {
		endField();
		records.push(record);
		record = [];
	};
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (quoted) {
			if (ch === '"' && text[i + 1] === '"') {
				field += '"';
				i++;
			} else if (ch === '"') quoted = false;
			else field += ch;
		} else if (ch === '"') quoted = true;
		else if (ch === ',') endField();
		else if (ch === '\n' || ch === '\r') {
			if (ch === '\r' && text[i + 1] === '\n') i++;
			endRecord();
		} else field += ch;
	}
	if (field || record.length) endRecord();
	const [header, ...body] = records.filter((r) => r.some((v) => v !== ''));
	return body.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])) as Row);
}

// ---------------------------------------------------------------- pasos

async function pool<T>(
	items: T[],
	worker: (item: T, i: number) => Promise<void>,
	stopped: () => boolean
) {
	let next = 0;
	await Promise.all(
		Array.from({ length: CONCURRENCY }, async () => {
			while (next < items.length && !stopped()) {
				const i = next++;
				await worker(items[i], i);
			}
		})
	);
}

/** Sin saldo o con la clave rechazada, seguir solo haría peticiones que van a fallar. */
function isFatal(err: unknown): boolean {
	return (
		err instanceof Anthropic.APIError &&
		(err.status === 401 ||
			err.status === 402 ||
			err.status === 403 ||
			/credit balance/i.test(err.message))
	);
}

async function plan(source: string, dest: string) {
	if (!process.env.ANTHROPIC_API_KEY) throw new Error('Falta ANTHROPIC_API_KEY');
	// Con un tier bajo de la API, 4 en paralelo pueden dar 429: el SDK reintenta con espera.
	const anthropic = new Anthropic({ maxRetries: 5 });
	await mkdir(join(WORK, 'grids'), { recursive: true });
	await mkdir(join(WORK, 'readings'), { recursive: true });

	const shorts = await filmography();
	console.log(`Wikipedia: ${shorts.length} cortos`);

	const files = await findVideos(source, dest);
	console.log(`${files.length} ficheros en ${source}`);

	const rows: Row[] = [];
	let fatal: unknown = null;
	await pool(
		files,
		async (file, i) => {
			const rel = relative(source, file);
			const key = cacheKey(rel);
			const seconds = await duration(file);
			const kind = kindOf(seconds);
			const row: Row = {
				action: kind === 'extra' ? 'extra' : 'skip',
				src: rel,
				minutes: (seconds / 60).toFixed(1),
				kind,
				read_title: '',
				read_director: '',
				read_year: '',
				confidence: '',
				wiki_title: '',
				release_date: '',
				season: '',
				episode: '',
				dest: kind === 'extra' ? join(dest, 'extras', rel.replaceAll('/', '_')) : '',
				notes: ''
			};
			rows[i] = row;
			if (kind !== 'short') return;

			try {
				const grid = join(WORK, 'grids', `${key}.jpg`);
				await titleGrid(file, grid);
				const cached = join(WORK, 'readings', `${key}.json`);
				const reading: Reading = existsSync(cached)
					? await Bun.file(cached).json()
					: await readTitleCard(anthropic, grid);
				await Bun.write(cached, JSON.stringify(reading, null, 2));

				row.read_title = reading.title ?? '';
				row.read_director = reading.director ?? '';
				row.read_year = reading.copyright_year ? String(reading.copyright_year) : '';
				row.confidence = reading.confidence;
				row.notes = `grid: ${key}.jpg${reading.notes ? `; ${reading.notes}` : ''}`;
				row.action = 'review';
				if (!reading.is_title_card) return;

				const found = match(reading, shorts);
				if (!found) return;
				row.wiki_title = found.short.title;
				row.release_date = found.short.date;
				row.season = String(found.short.season);
				row.episode = String(found.short.episode);
				row.dest = destFor(dest, found.short);
				if (found.exact && reading.confidence !== 'low') row.action = 'move';
			} catch (err) {
				if (isFatal(err)) fatal ??= err;
				row.action = 'review';
				row.notes = `error: ${err instanceof Error ? err.message : err}`;
			} finally {
				console.log(
					`[${i + 1}/${files.length}] ${row.action.padEnd(9)} ${rel} → ${row.wiki_title || row.read_title}`
				);
			}
		},
		() => fatal !== null
	);

	if (fatal) {
		const message = fatal instanceof Error ? fatal.message : String(fatal);
		throw new Error(
			`Parado, la API ha rechazado la petición: ${message}\nLas lecturas hechas están en caché: al relanzar plan sigue por donde iba.`
		);
	}

	// El mismo corto en varios discos: se queda el fichero más grande, el resto se marca.
	const byEpisode = new Map<string, Row[]>();
	for (const row of rows) {
		if (!row.season || row.action === 'skip') continue;
		const k = `${row.season}-${row.episode}`;
		byEpisode.set(k, [...(byEpisode.get(k) ?? []), row]);
	}
	for (const group of byEpisode.values()) {
		if (group.length < 2) continue;
		const sizes = await Promise.all(
			group.map((r) => stat(join(source, r.src)).then((s) => s.size))
		);
		const keep = sizes.indexOf(Math.max(...sizes));
		group.forEach((r, i) => {
			if (i === keep) return;
			r.action = 'duplicate';
			r.notes = `duplicado de ${group[keep].src}; ${r.notes}`;
		});
	}

	const out = join(WORK, 'plan.csv');
	await Bun.write(out, toCsv(rows));
	const count = (a: Action) => rows.filter((r) => r.action === a).length;
	console.log(
		`\n${out}\nmove ${count('move')} · review ${count('review')} · duplicate ${count('duplicate')} · extra ${count('extra')} · skip ${count('skip')}`
	);
	console.log(`Las cuadrículas para revisar están en ${join(WORK, 'grids')}`);
}

function xml(s: string): string {
	return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Metadatos locales con lockdata, para que Jellyfin no los pise con otro proveedor. */
function episodeNfo(short: WikiShort): string {
	return `<?xml version="1.0" encoding="utf-8" standalone="yes"?>
<episodedetails>
  <title>${xml(short.title)}</title>
  <showtitle>${SERIES}</showtitle>
  <season>${short.season}</season>
  <episode>${short.episode}</episode>
  <aired>${short.date}</aired>
  <premiered>${short.date}</premiered>
  <year>${short.season}</year>
  <director>${xml(short.director)}</director>
  <tag>${xml(short.banner === 'MM' ? 'Merrie Melodies' : 'Looney Tunes')}</tag>
  <plot>${xml(short.plot)}</plot>
  <lockdata>true</lockdata>
</episodedetails>
`;
}

async function apply(source: string, dest: string) {
	const rows = fromCsv(await Bun.file(join(WORK, 'plan.csv')).text());
	const shorts = await filmography();
	const bySlot = new Map(shorts.map((s) => [`${s.season}-${s.episode}`, s]));

	const showNfo = join(dest, 'tvshow.nfo');
	if (!existsSync(showNfo)) {
		await mkdir(dest, { recursive: true });
		await Bun.write(
			showNfo,
			`<?xml version="1.0" encoding="utf-8" standalone="yes"?>\n<tvshow>\n  <title>${SERIES}</title>\n</tvshow>\n`
		);
	}

	let moved = 0;
	for (const row of rows) {
		if (row.action !== 'move' && row.action !== 'extra') continue;
		const from = join(source, row.src);
		if (!existsSync(from)) {
			console.warn(`No existe (¿ya movido?): ${row.src}`);
			continue;
		}

		let to = row.dest;
		let short: WikiShort | undefined;
		if (row.action === 'move') {
			short = bySlot.get(`${row.season}-${row.episode}`);
			if (!short) {
				console.warn(`Sin corto en Wikipedia para S${row.season}E${row.episode}: ${row.src}`);
				continue;
			}
			to = destFor(dest, short);
		}
		if (existsSync(to)) {
			console.warn(`Ya existe, no se sobrescribe: ${to}`);
			continue;
		}

		await mkdir(dirname(to), { recursive: true });
		await rename(from, to);
		if (short) await Bun.write(to.replace(/\.mkv$/, '.nfo'), episodeNfo(short));
		moved++;
		console.log(`${row.src} → ${relative(dest, to)}`);
	}
	console.log(`\n${moved} ficheros movidos a ${dest}. Reescanea la biblioteca en Jellyfin.`);
}

// ---------------------------------------------------------------- main

if (import.meta.main) {
	const [command, sourceArg] = process.argv.slice(2);
	const source = sourceArg ?? DEFAULT_SOURCE;
	const dest = join(source, SERIES);

	if (command === 'plan') await plan(source, dest);
	else if (command === 'apply') await apply(source, dest);
	else {
		console.log(`Uso: bun ${basename(import.meta.path)} plan|apply [carpeta de origen]`);
		process.exit(1);
	}
}
