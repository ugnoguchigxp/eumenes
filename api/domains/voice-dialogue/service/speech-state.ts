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
	append: (text: string, final?: boolean) => void;
	work: Promise<void>;
	wake: () => void;
	error?: Error;
};
