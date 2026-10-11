export type PlaylistTrack = {
	id: string;
	title: string;
	subtitle?: string;
	durationSeconds?: number;
	disabled?: boolean;
};

/** src is resolved by the host; this component never requests business credentials. */
export type MusicTrack = PlaylistTrack & { src: string };
