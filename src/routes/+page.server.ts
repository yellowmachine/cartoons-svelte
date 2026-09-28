import { listFolders } from '$lib/server/jellyfin';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
	try {
		const folders = await listFolders();
		return { folders, error: null };
	} catch (err) {
		return { folders: [], error: err instanceof Error ? err.message : 'Error desconocido' };
	}
};
