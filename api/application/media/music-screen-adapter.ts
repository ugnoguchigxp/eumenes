import type { Database } from "bun:sqlite";
import { musicListInTransaction } from "../../domains/music";
import type { DomainAdapter } from "../../domains/tool-runtime";

export const MUSIC_SCREEN_ADAPTER_REF = "adapter:music-screen@1";
const MUSIC_LIST = "query:music-screen.list@1";

/** The screen registers a music-owned source; creation uses the conversation API. */
export const describeMusicScreenAdapter = () => ({
	owner: "music",
	operations: new Map(),
	queries: new Set([MUSIC_LIST]),
	inputAdapters: new Map(),
	projections: new Set<string>(),
	availability: "availability:music-screen@1",
});

export function createMusicScreenAdapter(): DomainAdapter {
	return {
		ref: MUSIC_SCREEN_ADAPTER_REF,
		describe: describeMusicScreenAdapter,
		availableInTransaction: () => true,
		snapshotInTransaction: () => ({}),
		invokeInTransaction: () => {
			throw new Error("unsupported_operation");
		},
		readInTransaction: () => null,
		sourceInTransaction(tx: Database, query, targetRef) {
			if (query !== MUSIC_LIST || targetRef !== undefined) return null;
			const items = musicListInTransaction(tx, "main");
			return {
				revision: Math.max(0, ...items.map((item) => item.updatedAt)),
				data: { items },
			};
		},
		targetInput: () => ({}),
	};
}
