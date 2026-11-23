import type { Database } from "bun:sqlite";
import { getLogger } from "../../../infrastructure/logger";
import { FORGET_KEY } from "../contracts";
import {
	type UnitTargets,
	excludedInbox,
	excludedItemIds,
	openUnitOf,
} from "../repository";
import { excludedTargets } from "./exclusions";
import type { StewardDeps } from "./types";

const log = getLogger("steward");

/** The closure delete takes at most this many excluded forgets in one unit. */
const FORGETS_PER_UNIT = 8;

export type ClosureUnitSpec = {
	targets: UnitTargets;
	attempt: number;
};

/**
 * The closure delete of the forgets that were excluded at once: it does not wait for a conversation run and has a
 * unit slot of its own. `make` writes the unit and its queue job.
 */
export function createClosureKick(
	deps: StewardDeps,
	make: (db: Database, spec: ClosureUnitSpec) => boolean,
) {
	/** What the library holds excluded that no `excluded` request of the inbox names; null when there is none. */
	function orphanExclusions(db: Database) {
		const held = excludedTargets(db, deps);
		const named = new Set(excludedItemIds(db));
		const itemIds = held.itemIds.filter((id) => !named.has(id));
		return itemIds.length > 0 ? { itemIds } : null;
	}

	return {
		kick(db: Database, options: { orphans?: boolean } = {}) {
			try {
				if (openUnitOf(db, FORGET_KEY, "maintenance")) return;
				const rows = excludedInbox(db, FORGETS_PER_UNIT);
				// After a restore the library's journal puts the exclusions back, while the inbox may be as old as the backup:
				// what is excluded and named by no request is closed too.
				const orphans = options.orphans === true ? orphanExclusions(db) : null;
				if (rows.length === 0 && !orphans) return;
				make(db, {
					targets: {
						requests: rows.map((row) => row.id),
						urgent: true,
						...(orphans ? { orphans: orphans.itemIds } : {}),
					},
					attempt: Math.max(0, ...rows.map((row) => row.failures)),
				});
			} catch (error) {
				log.warn(
					"steward.closure_kick_failed",
					{ reason: "kick_failed" },
					error,
				);
			}
		},
	};
}
