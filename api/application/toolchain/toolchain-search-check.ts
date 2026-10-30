import type { Hono } from "hono";
import type { SqliteStore } from "../../infrastructure/sqlite";
import type { Capabilities } from "../../domains/capabilities";
import type { ToolchainHistory } from "../../domains/toolchain-history";
import type { ToolchainRoutingPort } from "../../domains/dialogue";

/** Ranks past this are told as one group. */
const RANKED = 8;

/**
 * The search check (the toolchain search and choice design, section 6): for the past requests a toolchain was
 * chosen for, where the chosen toolchain stands now by similarity, and whether the search's slots offer it. It reads
 * the stored request vectors and the index only, once (no embedding call); a request whose space the index no longer
 * has, or whose toolchain is unavailable now, is only counted.
 */
export function createSearchCheck(deps: {
	store: SqliteStore;
	capabilities: Capabilities;
	history: ToolchainHistory;
	routing: Pick<ToolchainRoutingPort, "catalogInTransaction">;
}) {
	return {
		run() {
			return deps.store.read((db) => {
				const available = new Set(
					deps.routing.catalogInTransaction(db).map((entry) => entry.id),
				);
				const ranks: Record<string, number> = {};
				const missed: Array<{
					selectionId: string;
					toolchainId: string;
					rank: number | null;
					createdAt: number;
				}> = [];
				let checked = 0,
					offered = 0,
					unavailable = 0,
					unindexed = 0;
				const past = deps.history
					.chosenQueriesInTransaction(db)
					.filter((query) => {
						if (available.has(query.toolchainId)) return true;
						unavailable++;
						return false;
					});
				const ranked = deps.capabilities.rankPastRequestsInTransaction(db, {
					queries: past.map((query) => ({
						spaceKey: query.spaceKey,
						values: query.vector,
					})),
					available: (id) => available.has(id),
				});
				past.forEach((query, i) => {
					const { ranked: order, offered: slots } = ranked[i]!;
					if (!order.length) {
						unindexed++;
						return;
					}
					checked++;
					const at = order.indexOf(query.toolchainId);
					const rank = at < 0 || at >= RANKED ? null : at + 1;
					const label = rank === null ? `${RANKED + 1}+` : String(rank);
					ranks[label] = (ranks[label] ?? 0) + 1;
					if (slots.includes(query.toolchainId)) offered++;
					else
						missed.push({
							selectionId: query.selectionId,
							toolchainId: query.toolchainId,
							rank,
							createdAt: query.createdAt,
						});
				});
				return { checked, offered, ranks, unavailable, unindexed, missed };
			});
		},
	};
}
export type SearchCheck = ReturnType<typeof createSearchCheck>;

/** Authentication and Origin checks run in the application middleware for `/api/*` before this handler. */
export function registerSearchCheck(app: Hono, check: SearchCheck) {
	app.get("/api/toolchains/search-check", (c) => c.json(check.run()));
}
