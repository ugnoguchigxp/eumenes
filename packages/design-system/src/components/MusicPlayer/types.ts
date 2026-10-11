export type PlaylistTrack = {
	id: string;
	title: string;
	subtitle?: string;
	durationSeconds?: number;
	disabled?: boolean;
	tags?: readonly string[];
	createdAt?: string;
	favorite?: boolean;
	artworkUrl?: string;
	lyrics?: string;
	prompt?: string;
	model?: string;
	format?: string;
	instrumental?: boolean;
};

/** src is resolved by the host; this component never requests business credentials. */
export type MusicTrack = PlaylistTrack & { src: string };

export type MusicPlaybackState = {
	id: string;
	playing: boolean;
	position: number;
	duration: number;
	analyser: AnalyserNode | null;
	analysisError: boolean;
};
