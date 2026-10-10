import type { Database } from "bun:sqlite";
import type { RouteState } from "../contracts";
import * as repo from "../repository";
import { type Clock, deriveState, stateTokenOf, systemClock } from "./registry";

export type ControlResult =
	| {
			kind: "updated";
			key: string;
			state: RouteState;
			stateToken: string;
			generation: number;
	  }
	| { kind: "conflict" }
	| { kind: "not_found" };

/** Management of stored legacy records; it never interprets user requests. */
export function createPlans(opts: { clock?: Clock } = {}) {
	const clock = opts.clock ?? systemClock;
	const control = (
		db: Database,
		key: string,
		expectedStateToken: string,
		apply: (k: repo.KeyRow, now: number) => boolean,
	): ControlResult => {
		const epoch = repo.getEpoch(db);
		const k = repo.getKey(db, epoch, key);
		if (!k) return { kind: "not_found" };
		if (stateTokenOf(k) !== expectedStateToken) return { kind: "conflict" };
		const now = clock.now();
		if (!apply(k, now)) return { kind: "conflict" };
		const n = repo.getKey(db, epoch, key)!;
		return {
			kind: "updated",
			key,
			state: deriveState(db, n, now),
			stateToken: stateTokenOf(n),
			generation: n.generation,
		};
	};

	/** Disable a stored record and interrupt legacy drafts. */
	function disableInTransaction(
		db: Database,
		input: { key: string; expectedStateToken: string },
	): ControlResult {
		return control(db, input.key, input.expectedStateToken, (k, now) => {
			if (!repo.touchKey(db, k, now, { enabled: 0, generation: true }))
				return false;
			repo.terminateOpenDrafts(
				db,
				k.incarnation,
				"interrupted",
				"route_disabled",
				now,
			);
			return true;
		});
	}
	/** Clear the stored active pointer and candidate, keeping the record for display. */
	function rediscoverInTransaction(
		db: Database,
		input: { key: string; expectedStateToken: string },
	): ControlResult {
		return control(db, input.key, input.expectedStateToken, (k, now) => {
			if (
				!repo.touchKey(db, k, now, {
					enabled: 1,
					active_version_id: null,
					suspension_reason: "rediscover",
					retry_after: null,
					generation: true,
				})
			)
				return false;
			repo.deleteCandidate(db, k.epoch, k.key);
			repo.terminateOpenDrafts(
				db,
				k.incarnation,
				"superseded",
				"rediscover",
				now,
			);
			return true;
		});
	}

	return { disableInTransaction, rediscoverInTransaction };
}
