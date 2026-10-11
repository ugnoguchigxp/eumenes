export type MusicResource = {
	kind: "music";
	revision: number;
	currentId: string;
	tracks: {
		id: string;
		title: string;
		subtitle?: string;
		durationSeconds?: number;
		disabled?: boolean;
		url?: string;
		downloadName?: string;
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
export const isSafeAudioUrl = (value: string) => /^(https:|blob:)/i.test(value);
