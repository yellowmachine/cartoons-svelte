export type FolderOption = {
	/** Jellyfin item id when it's a real folder, or a synthetic `path:` id when derived from file paths. */
	id: string;
	name: string;
};

export type PlaylistItem = {
	id: string;
	name: string;
	seriesName?: string;
	hasImage: boolean;
};

export type ClientSession = {
	id: string;
	deviceName: string;
	client: string;
};
