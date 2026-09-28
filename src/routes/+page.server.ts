import { env } from '$env/dynamic/private';
import { listFolders } from '$lib/server/jellyfin';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
	const authEnabled = Boolean(env.ADMIN_PASSWORD);
	try {
		const folders = await listFolders();
		return { folders, error: null, authEnabled };
	} catch (err) {
		return {
			folders: [],
			error: err instanceof Error ? err.message : 'Error desconocido',
			authEnabled
		};
	}
};
