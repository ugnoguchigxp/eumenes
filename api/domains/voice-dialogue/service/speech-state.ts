import type { SpeechDelivery } from "../../delivery";
export type Chunk = {
	index: number;
	text: string;
	wav: Uint8Array;
	requestId?: string;
	delivery?: SpeechDelivery;
};
export type Speech = {
	chunks: Map<number, Chunk>;
	finished: boolean;
	append: (text: string, final?: boolean) => void;
	work: Promise<void>;
	wake: () => void;
	error?: Error;
};
