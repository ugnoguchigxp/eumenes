import type { Database } from "bun:sqlite";

type Forgotten = { messageIds: readonly string[]; itemIds: readonly string[] };

/**
 * What a forget removes from the toolchain's own records, in the forget's transaction: the agent executions that stood
 * on what was forgotten, and the router's traces and corrections that hold the forgotten utterance (spec
 * toolchain-router-redesign 2026-11-01 §5.4).
 */
export function toolchainForgetPurge(toolchain: {
	agents: {
		executions: {
			purgeSourcesInTransaction(db: Database, input: Forgotten): void;
		};
	};
	history: {
		forgetRouterInTransaction(
			db: Database,
			messageIds: readonly string[],
		): number;
	};
}) {
	return (db: Database, purge: Forgotten) => {
		toolchain.agents.executions.purgeSourcesInTransaction(db, purge);
		toolchain.history.forgetRouterInTransaction(db, purge.messageIds);
	};
}
