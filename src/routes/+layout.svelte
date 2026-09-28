<script lang="ts">
	import { browser } from '$app/environment';
	import '../app.css';

	let { children } = $props();

	// vite-plugin-pwa no inyecta el registro automáticamente en el app.html de
	// SvelteKit (eso solo funciona en un index.html de Vite puro), así que se
	// registra el Service Worker generado (build/client/sw.js) a mano.
	if (browser && 'serviceWorker' in navigator) {
		navigator.serviceWorker.register('/sw.js');
	}
</script>

{@render children()}
