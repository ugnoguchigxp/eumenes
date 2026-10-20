export type MusicResource = {
	kind: "music";
	revision: number;
	currentId: string;
	/** The host can generate artwork from the current track's prompt. */
	canArtwork?: boolean;
	creation?: {
		models?: {
			task: "music" | "vocals" | "sound-effect";
			defaultDurationSeconds?: number;
			maxDurationSeconds: number;
		}[];
		busy: boolean;
		status?: GenerationResource["status"];
		title?: string;
		description?: string;
		canCancel?: boolean;
	};
	library?: {
		filter: {
			q: string;
			tags: string[];
			favorite?: boolean;
			sort: "createdAt" | "relevance";
			order: "asc" | "desc";
		};
		tags: { tag: string; count: number }[];
		loading: boolean;
		error?: string;
		total?: number;
		hasMore: boolean;
	};
	tracks: {
		id: string;
		title: string;
		subtitle?: string;
		durationSeconds?: number;
		disabled?: boolean;
		url?: string;
		downloadName?: string;
		tags?: string[];
		createdAt?: string;
		favorite?: boolean;
		artworkUrl?: string;
		artworkStatus?: "generating" | "completed" | "failed";
		lyrics?: string;
		prompt?: string;
		model?: string;
		format?: string;
		task?: "music" | "sound-effect";
		runtime?: string;
		instrumental?: boolean;
	}[];
};
export type GenerationResource = {
	kind: "generation";
	revision: number;
	status: "pending" | "running" | "completed" | "failed" | "cancelled";
	title: string;
	description?: string;
	progress?: number;
	hidden?: boolean;
	canCancel?: boolean;
	canRetry?: boolean;
};
/** URLs are supplied by the authorized host, never by the UI JSON. */
export const isSafeAudioUrl = (value: string) =>
	/^(https:|blob:)/i.test(value) ||
	/^\/api\/music\/tracks\/[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}\/audio$/.test(value);
