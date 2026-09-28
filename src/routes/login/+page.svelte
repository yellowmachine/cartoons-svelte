<script lang="ts">
	import { enhance } from '$app/forms';
	import type { ActionData } from './$types';

	let { form }: { form: ActionData } = $props();

	let submitting = $state(false);
</script>

<svelte:head>
	<title>Entrar — Cartoons</title>
</svelte:head>

<div
	class="from-toon-sky via-toon-sky to-toon-grass flex min-h-screen items-center justify-center bg-gradient-to-b px-4"
>
	<div class="bg-toon-bubble w-full max-w-sm rounded-3xl p-8 shadow-xl">
		<h1 class="text-toon-ink text-center text-4xl font-bold">📺 Cartoons</h1>
		<p class="text-toon-ink/70 mt-2 mb-6 text-center">Escribe la contraseña para entrar</p>

		<form
			method="POST"
			class="space-y-4"
			use:enhance={() => {
				submitting = true;
				return async ({ update }) => {
					await update();
					submitting = false;
				};
			}}
		>
			<!-- svelte-ignore a11y_autofocus -->
			<input
				id="password"
				name="password"
				type="password"
				autocomplete="current-password"
				autofocus
				required
				class="border-toon-ink/15 text-toon-ink focus:border-toon-grape w-full rounded-2xl border-3 bg-white px-4
					py-3 text-lg focus:outline-none"
			/>

			{#if form?.error}
				<p class="text-toon-coral text-center font-medium">{form.error}</p>
			{/if}

			<button
				type="submit"
				disabled={submitting}
				class="bg-toon-sun text-toon-ink w-full rounded-full px-6 py-4 text-xl font-bold
					shadow-[0_5px_0_rgba(43,33,64,0.25)] transition
					hover:brightness-105 active:translate-y-0.5 active:shadow-[0_2px_0_rgba(43,33,64,0.25)]
					disabled:cursor-not-allowed disabled:opacity-50"
			>
				{submitting ? 'Comprobando…' : 'Entrar'}
			</button>
		</form>
	</div>
</div>
