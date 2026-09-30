<script lang="ts">
	import { browser } from '$app/environment';
	import { SvelteSet } from 'svelte/reactivity';
	import type { ClientSession, FolderOption, PlaylistItem } from '$lib/types';

	const SELECTED_FOLDERS_KEY = 'cartoons:selectedFolders';
	const EXCLUDE_WATCHED_KEY = 'cartoons:excludeWatched';

	function loadStoredSelection(): string[] {
		if (!browser) return [];
		try {
			const raw = localStorage.getItem(SELECTED_FOLDERS_KEY);
			return raw ? JSON.parse(raw) : [];
		} catch {
			return [];
		}
	}

	function loadStoredExcludeWatched(): boolean {
		if (!browser) return true;
		try {
			return localStorage.getItem(EXCLUDE_WATCHED_KEY) !== 'false';
		} catch {
			return true;
		}
	}

	let { data } = $props();

	const folders: FolderOption[] = $derived(data.folders);

	let selected = new SvelteSet<string>(loadStoredSelection());

	$effect(() => {
		if (!browser) return;
		try {
			localStorage.setItem(SELECTED_FOLDERS_KEY, JSON.stringify([...selected]));
		} catch {
			// localStorage puede no estar disponible (modo privado, cuota llena…); no es crítico.
		}
	});

	let excludeWatched = $state(loadStoredExcludeWatched());

	$effect(() => {
		if (!browser) return;
		try {
			localStorage.setItem(EXCLUDE_WATCHED_KEY, String(excludeWatched));
		} catch {
			// Igual que con las carpetas: si no se puede guardar, no pasa nada.
		}
	});

	let generating = $state<'random' | 'continue' | null>(null);
	let generateError = $state<string | null>(null);

	let items = $state<PlaylistItem[]>([]);
	let excluded = new SvelteSet<string>();
	let hasGenerated = $state(false);

	let confirming = $state(false);
	let confirmError = $state<string | null>(null);
	let confirmed = $state(false);
	let confirmedItemIds = $state<string[]>([]);
	let sessions = $state<ClientSession[]>([]);

	let playingSessionId = $state<string | null>(null);
	let playedSessionId = $state<string | null>(null);
	let playError = $state<string | null>(null);

	const includedCount = $derived(items.length - excluded.size);

	function toggleFolder(id: string) {
		if (selected.has(id)) selected.delete(id);
		else selected.add(id);
	}

	function toggleItem(id: string) {
		if (excluded.has(id)) excluded.delete(id);
		else excluded.add(id);
	}

	async function generate(mode: 'random' | 'continue') {
		generating = mode;
		generateError = null;
		transcript = null;
		confirmed = false;
		confirmError = null;
		sessions = [];
		playedSessionId = null;
		try {
			const res = await fetch('/api/generate', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ folderIds: [...selected], excludeWatched, mode })
			});
			if (!res.ok) {
				const body = await res.json().catch(() => null);
				throw new Error(body?.message ?? `Error ${res.status}`);
			}
			const result = await res.json();
			items = result.items;
			excluded.clear();
			hasGenerated = true;
		} catch (err) {
			generateError = err instanceof Error ? err.message : 'Algo fue mal';
		} finally {
			generating = null;
		}
	}

	// getUserMedia solo funciona en un contexto seguro (https o localhost).
	const micSupported = browser && window.isSecureContext && !!navigator.mediaDevices?.getUserMedia;

	let recording = $state(false);
	let listening = $state(false);
	let transcript = $state<string | null>(null);
	let mediaRecorder: MediaRecorder | null = null;

	async function toggleRecording() {
		if (recording) {
			mediaRecorder?.stop();
			return;
		}

		generateError = null;
		transcript = null;
		try {
			const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
			const chunks: Blob[] = [];
			const recorder = new MediaRecorder(stream);
			recorder.ondataavailable = (e) => {
				if (e.data.size > 0) chunks.push(e.data);
			};
			recorder.onstop = () => {
				stream.getTracks().forEach((t) => t.stop());
				recording = false;
				askAssistant(new Blob(chunks, { type: recorder.mimeType || 'audio/webm' }));
			};
			recorder.start();
			mediaRecorder = recorder;
			recording = true;
		} catch {
			generateError = 'No se ha podido acceder al micrófono';
		}
	}

	async function askAssistant(audio: Blob) {
		listening = true;
		confirmed = false;
		confirmError = null;
		sessions = [];
		playedSessionId = null;
		try {
			const res = await fetch('/api/assistant', {
				method: 'POST',
				headers: { 'Content-Type': audio.type },
				body: audio
			});
			if (!res.ok) {
				const body = await res.json().catch(() => null);
				throw new Error(body?.message ?? `Error ${res.status}`);
			}
			const result = await res.json();
			transcript = result.transcript;
			if (result.folderIds.length === 0) {
				throw new Error('No he encontrado ninguna carpeta que encaje');
			}
			selected.clear();
			for (const id of result.folderIds) selected.add(id);
			excludeWatched = result.excludeWatched;
			items = result.items;
			excluded.clear();
			hasGenerated = true;
		} catch (err) {
			generateError = err instanceof Error ? err.message : 'Algo fue mal';
		} finally {
			listening = false;
		}
	}

	async function confirmPlaylist() {
		const itemIds = items.filter((i) => !excluded.has(i.id)).map((i) => i.id);
		if (itemIds.length === 0) return;

		confirming = true;
		confirmError = null;
		try {
			const res = await fetch('/api/playlist', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ itemIds })
			});
			if (!res.ok) {
				const body = await res.json().catch(() => null);
				throw new Error(body?.message ?? `Error ${res.status}`);
			}
			const result = await res.json();
			confirmedItemIds = itemIds;
			sessions = result.sessions;
			confirmed = true;
		} catch (err) {
			confirmError = err instanceof Error ? err.message : 'Algo fue mal';
		} finally {
			confirming = false;
		}
	}

	async function playOn(session: ClientSession) {
		playingSessionId = session.id;
		playedSessionId = null;
		playError = null;
		try {
			const res = await fetch('/api/play', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					sessionId: session.id,
					itemIds: confirmedItemIds
				})
			});
			if (!res.ok) {
				const body = await res.json().catch(() => null);
				throw new Error(body?.message ?? `Error ${res.status}`);
			}
			playedSessionId = session.id;
		} catch (err) {
			playError = err instanceof Error ? err.message : 'Algo fue mal';
		} finally {
			playingSessionId = null;
		}
	}
</script>

<svelte:head>
	<title>Cartoons — Para ver hoy</title>
</svelte:head>

<div
	class="from-toon-sky via-toon-sky to-toon-grass min-h-screen bg-gradient-to-b px-4 py-10 sm:px-8"
>
	<div class="mx-auto max-w-3xl">
		<header class="relative mb-8 text-center">
			{#if data.authEnabled}
				<form method="POST" action="/logout" class="absolute top-0 right-0">
					<button
						type="submit"
						class="rounded-full bg-white/20 px-4 py-2 text-sm font-semibold text-white backdrop-blur
							transition hover:bg-white/30"
					>
						🚪 Salir
					</button>
				</form>
			{/if}
			<h1
				class="text-5xl font-bold text-white drop-shadow-[0_3px_0_rgba(43,33,64,0.35)] sm:text-6xl"
			>
				📺 Cartoons
			</h1>
			<p class="mt-2 text-lg font-medium text-white/90">
				Elige qué carpetas ver y prepara la sesión de hoy
			</p>
		</header>

		{#if data.error}
			<div
				class="border-toon-coral bg-toon-bubble text-toon-ink rounded-3xl border-4 p-6 shadow-lg"
			>
				<p class="text-xl font-semibold">😵 No hemos podido hablar con Jellyfin</p>
				<p class="mt-2 font-mono text-sm opacity-80">{data.error}</p>
			</div>
		{:else}
			<section class="bg-toon-bubble rounded-3xl p-6 shadow-xl sm:p-8">
				<div class="mb-4 flex flex-wrap items-center justify-between gap-3">
					<h2 class="text-toon-ink text-2xl font-semibold">🗂️ Carpetas</h2>
					<label
						class="text-toon-ink flex cursor-pointer items-center gap-2 font-semibold select-none"
					>
						<input
							type="checkbox"
							bind:checked={excludeWatched}
							class="accent-toon-grape h-5 w-5 cursor-pointer"
						/>
						Excluir los ya vistos
					</label>
				</div>

				{#if folders.length === 0}
					<p class="text-toon-ink/70">No se han encontrado carpetas en tu Jellyfin.</p>
				{:else}
					<div class="grid grid-cols-2 gap-3 sm:grid-cols-3">
						{#each folders as folder (folder.id)}
							<button
								type="button"
								onclick={() => toggleFolder(folder.id)}
								class="flex items-center gap-2 rounded-2xl border-3 px-4 py-3 text-left font-semibold transition
									{selected.has(folder.id)
									? 'border-toon-grape bg-toon-grape animate-toon-pop text-white shadow-md'
									: 'border-toon-ink/15 text-toon-ink hover:border-toon-grape/50 bg-white'}"
							>
								<span
									class="flex h-5 w-5 shrink-0 items-center justify-center rounded-md border-2
										{selected.has(folder.id) ? 'text-toon-grape border-white bg-white' : 'border-toon-ink/30'}"
								>
									{#if selected.has(folder.id)}✓{/if}
								</span>
								<span class="truncate">{folder.name}</span>
							</button>
						{/each}
					</div>

					<div class="mt-6 flex flex-col gap-3 sm:flex-row">
						<button
							type="button"
							disabled={selected.size === 0 || generating !== null}
							onclick={() => generate('random')}
							class="bg-toon-sun text-toon-ink w-full rounded-full px-6 py-4 text-xl font-bold
								shadow-[0_5px_0_rgba(43,33,64,0.25)] transition
								hover:brightness-105 active:translate-y-0.5 active:shadow-[0_2px_0_rgba(43,33,64,0.25)]
								disabled:cursor-not-allowed disabled:opacity-50"
						>
							{generating === 'random' ? '🎲 Buscando…' : '🎲 10 al azar'}
						</button>
						<button
							type="button"
							disabled={selected.size !== 1 || generating !== null}
							onclick={() => generate('continue')}
							class="bg-toon-coral w-full rounded-full px-6 py-4 text-xl font-bold text-white
								shadow-[0_5px_0_rgba(43,33,64,0.25)] transition
								hover:brightness-105 active:translate-y-0.5 active:shadow-[0_2px_0_rgba(43,33,64,0.25)]
								disabled:cursor-not-allowed disabled:opacity-50"
						>
							{generating === 'continue' ? '▶️ Buscando…' : '▶️ Continuar'}
						</button>
					</div>

					<button
						type="button"
						disabled={!micSupported || listening || generating !== null}
						onclick={toggleRecording}
						title={micSupported ? undefined : 'El micrófono necesita https o localhost'}
						class="mt-3 w-full rounded-full px-6 py-4 text-xl font-bold text-white
							shadow-[0_5px_0_rgba(43,33,64,0.25)] transition
							hover:brightness-105 active:translate-y-0.5 active:shadow-[0_2px_0_rgba(43,33,64,0.25)]
							disabled:cursor-not-allowed disabled:opacity-50
							{recording ? 'animate-pulse bg-red-500' : 'bg-toon-grape'}"
					>
						{#if recording}
							⏹️ Escuchando… pulsa para terminar
						{:else if listening}
							🤔 Pensando…
						{:else}
							🎤 Pídemelo
						{/if}
					</button>

					{#if transcript}
						<p class="text-toon-ink/70 mt-2 text-center text-sm italic">«{transcript}»</p>
					{/if}

					{#if selected.size > 1}
						<p class="text-toon-ink/60 mt-2 text-center text-sm">
							Marca solo una carpeta para continuar
						</p>
					{/if}

					{#if generateError}
						<p class="text-toon-coral mt-3 text-center font-medium">{generateError}</p>
					{/if}
				{/if}
			</section>

			{#if hasGenerated}
				<section class="bg-toon-bubble mt-8 rounded-3xl p-6 shadow-xl sm:p-8">
					<h2 class="text-toon-ink mb-4 text-2xl font-semibold">✨ Para ver hoy</h2>

					{#if items.length === 0}
						<p class="text-toon-ink/70">
							{excludeWatched
								? 'No había nada sin ver en esas carpetas.'
								: 'No había nada en esas carpetas.'}
						</p>
					{:else}
						<p class="text-toon-ink/70 mb-4 text-sm">
							Desmarca lo que no te apetezca ver hoy antes de crear la lista.
						</p>
						<ul class="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-5">
							{#each items as item (item.id)}
								{@const included = !excluded.has(item.id)}
								<li>
									<button
										type="button"
										onclick={() => toggleItem(item.id)}
										class="relative block w-full overflow-hidden rounded-2xl bg-white text-left shadow-md transition
											{included ? '' : 'opacity-40 grayscale'}"
									>
										<span
											class="absolute top-2 right-2 z-10 flex h-6 w-6 items-center justify-center rounded-md border-2 shadow
												{included
												? 'text-toon-grape border-toon-grape bg-white'
												: 'border-white/70 bg-black/30 text-white'}"
										>
											{#if included}✓{/if}
										</span>
										{#if item.hasImage}
											<img
												src="/api/image/{item.id}"
												alt={item.name}
												class="aspect-2/3 w-full object-cover"
												loading="lazy"
											/>
										{:else}
											<div
												class="bg-toon-grape/20 flex aspect-2/3 w-full items-center justify-center text-4xl"
											>
												🎬
											</div>
										{/if}
										<div class="p-2">
											<p class="text-toon-ink truncate text-sm font-semibold">{item.name}</p>
											{#if item.seriesName}
												<p class="text-toon-ink/60 truncate text-xs">{item.seriesName}</p>
											{/if}
										</div>
									</button>
								</li>
							{/each}
						</ul>

						<button
							type="button"
							disabled={includedCount === 0 || confirming}
							onclick={confirmPlaylist}
							class="bg-toon-grape mt-6 w-full rounded-full px-6 py-4 text-xl font-bold text-white
								shadow-[0_5px_0_rgba(43,33,64,0.25)] transition
								hover:brightness-105 active:translate-y-0.5 active:shadow-[0_2px_0_rgba(43,33,64,0.25)]
								disabled:cursor-not-allowed disabled:opacity-50"
						>
							{confirming ? '✅ Creando…' : `✅ Crear "Para ver hoy" con ${includedCount}`}
						</button>

						{#if confirmError}
							<p class="text-toon-coral mt-3 text-center font-medium">{confirmError}</p>
						{/if}

						{#if confirmed}
							<h3 class="text-toon-ink mt-8 mb-3 text-xl font-semibold">📱 ¿Dónde lo vemos?</h3>
							{#if sessions.length === 0}
								<p class="text-toon-ink/70">No hay ningún Jellyfin abierto ahora mismo.</p>
							{:else}
								<div class="flex flex-wrap gap-3">
									{#each sessions as session (session.id)}
										<button
											type="button"
											disabled={playingSessionId === session.id}
											onclick={() => playOn(session)}
											class="bg-toon-grass rounded-full px-5 py-3 font-bold text-white shadow-[0_4px_0_rgba(43,33,64,0.25)]
												transition hover:brightness-105 active:translate-y-0.5 active:shadow-[0_1px_0_rgba(43,33,64,0.25)]
												disabled:cursor-wait disabled:opacity-70"
										>
											{#if playingSessionId === session.id}
												⏳ Enviando…
											{:else if playedSessionId === session.id}
												✅ Reproduciendo en {session.deviceName}
											{:else}
												▶️ Play en {session.deviceName}
											{/if}
										</button>
									{/each}
								</div>
								{#if playError}
									<p class="text-toon-coral mt-3 font-medium">{playError}</p>
								{/if}
							{/if}
						{/if}
					{/if}
				</section>
			{/if}
		{/if}
	</div>
</div>
