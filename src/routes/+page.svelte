<script lang="ts">
	import { SvelteSet } from 'svelte/reactivity';
	import type { ClientSession, FolderOption, PlaylistItem } from '$lib/types';

	let { data } = $props();

	const folders: FolderOption[] = $derived(data.folders);

	let selected = new SvelteSet<string>();
	let generating = $state(false);
	let generateError = $state<string | null>(null);

	let items = $state<PlaylistItem[]>([]);
	let sessions = $state<ClientSession[]>([]);
	let hasGenerated = $state(false);

	let playingSessionId = $state<string | null>(null);
	let playedSessionId = $state<string | null>(null);
	let playError = $state<string | null>(null);

	function toggleFolder(id: string) {
		if (selected.has(id)) selected.delete(id);
		else selected.add(id);
	}

	async function generate() {
		generating = true;
		generateError = null;
		playedSessionId = null;
		try {
			const res = await fetch('/api/generate', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ folderIds: [...selected] })
			});
			if (!res.ok) {
				const body = await res.json().catch(() => null);
				throw new Error(body?.message ?? `Error ${res.status}`);
			}
			const result = await res.json();
			items = result.items;
			sessions = result.sessions;
			hasGenerated = true;
		} catch (err) {
			generateError = err instanceof Error ? err.message : 'Algo fue mal';
		} finally {
			generating = false;
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
					itemIds: items.map((i) => i.id)
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
		<header class="mb-8 text-center">
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
				<h2 class="text-toon-ink mb-4 text-2xl font-semibold">🗂️ Carpetas</h2>

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

					<button
						type="button"
						disabled={selected.size === 0 || generating}
						onclick={generate}
						class="bg-toon-sun text-toon-ink mt-6 w-full rounded-full px-6 py-4 text-xl font-bold
							shadow-[0_5px_0_rgba(43,33,64,0.25)] transition
							hover:brightness-105 active:translate-y-0.5 active:shadow-[0_2px_0_rgba(43,33,64,0.25)]
							disabled:cursor-not-allowed disabled:opacity-50"
					>
						{generating ? '🎲 Buscando…' : '🎲 10 al azar y crear "Para ver hoy"'}
					</button>

					{#if generateError}
						<p class="text-toon-coral mt-3 text-center font-medium">{generateError}</p>
					{/if}
				{/if}
			</section>

			{#if hasGenerated}
				<section class="bg-toon-bubble mt-8 rounded-3xl p-6 shadow-xl sm:p-8">
					<h2 class="text-toon-ink mb-4 text-2xl font-semibold">✨ Para ver hoy</h2>

					{#if items.length === 0}
						<p class="text-toon-ink/70">No había nada sin ver en esas carpetas.</p>
					{:else}
						<ul class="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-5">
							{#each items as item (item.id)}
								<li class="overflow-hidden rounded-2xl bg-white shadow-md">
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
								</li>
							{/each}
						</ul>

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
				</section>
			{/if}
		{/if}
	</div>
</div>
