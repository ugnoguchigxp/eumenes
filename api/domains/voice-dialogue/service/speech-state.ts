import type { SpeechDelivery } from "../../delivery";
type Chunk = {
	index: number;
	text: string;
	wav: Uint8Array;
	requestId?: string;
	delivery?: SpeechDelivery;
};
export type Speech = {
	createdAtMs: number;
	/** Clauses given up on after retries. */
	skipped: number;
	chunks: Map<number, Chunk>;
	finished: boolean;
	append: (text: string, final?: boolean, flush?: boolean) => void;
	work: Promise<void>;
	wake: () => void;
	/** Wait for the clauses already enqueued to be acknowledged by the player. */
	waitForPlayback: (signal: AbortSignal) => Promise<void>;
	markPlayed: (index: number) => void;
	/** Acknowledged clauses in playback order, independent of report arrival order. */
	played: Array<{ index: number; text: string }>;
	error?: Error;
};
