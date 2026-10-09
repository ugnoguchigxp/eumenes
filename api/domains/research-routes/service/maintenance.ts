import type { Database } from "bun:sqlite";
import { z } from "zod";
import type { HandlerDefinition } from "../../queue";
import { jobKinds, limits, ownerScope, ttl } from "../contracts";
import * as repo from "../repository";
import type { QueueSlice, SourceAdoptionPort } from "./flow";
import { type Clock, systemClock } from "./registry";

export type PruneLearned = (
	db: Database,
	input: { remove: string[]; protect: string[] },
) => { removed: number };
export type MaintenanceOptions = {
	clock?: Clock;
	externalBytes?: (db: Database) => number;
	/** capabilities' public GC: only learned, route-only package revisions outside `protect` are removed. */
	prune?: PruneLearned;
	adoption?: Pick<SourceAdoptionPort, "protectedBindingsInTransaction">;
	queue?: QueueSlice;
};
export type SweepMode = "ttl" | "epoch";
export type SweepResult = { removed: number; hasMore: boolean };

export const sweepPayload = z
	.object({
		mode: z.enum(["ttl", "epoch"]),
		round: z.number().int().min(0).max(10_000),
	})
	.strict();
export type SweepPayload = z.infer<typeof sweepPayload>;
const hour = 3600_000;
const ttlRounds = 50;

export function createMaintenance(opts: MaintenanceOptions = {}) {
	const clock = opts.clock ?? systemClock;
	const ext = opts.externalBytes ?? (() => 0);

	/** Versions held by running roots plus the base of every open draft; they must survive reclaim. */
	function heldVersions(db: Database): Set<string> {
		const held = new Set<string>(
			opts.adoption?.protectedBindingsInTransaction?.(db) ?? [],
		);
		for (const r of db
			.query(
				"SELECT base_version_id v FROM research_route_drafts WHERE base_version_id IS NOT NULL AND state IN ('queued','authoring','reviewing')",
			)
			.all() as { v: string }[])
			held.add(r.v);
		return held;
	}
	function prune(db: Database, freed: string[]) {
		if (!freed.length || !opts.prune) return;
		const protect = (
			db
				.query(
					"SELECT DISTINCT package_revision_id p FROM research_route_revisions",
				)
				.all() as { p: string }[]
		).map((r) => r.p);
		opts.prune(db, { remove: [...new Set(freed)], protect });
	}
	const blocked = (db: Database, incarnation: string, held: Set<string>) =>
		repo
			.revisionsOfIncarnation(db, incarnation)
			.some((r) => held.has(r.version_id));

	/** Physical reclaim of rows hidden by a global clear, key by key. */
	function sweepEpoch(db: Database, limit: number): SweepResult {
		const epoch = repo.getEpoch(db);
		const keys = repo.staleEpochKeys(db, epoch, 200);
		const held = heldVersions(db);
		const freed: string[] = [];
		let removed = 0;
		let hasMore = false;
		for (const k of keys) {
			if (removed >= limit) {
				hasMore = true;
				break;
			}
			if (blocked(db, k.incarnation, held)) continue;
			const t = repo.deleteKeyTree(db, k.incarnation);
			removed += t.rows;
			freed.push(...t.packageIds);
		}
		if (!hasMore && keys.length === 200) hasMore = true;
		prune(db, freed);
		return { removed, hasMore };
	}

	/** TTL / bytes / idle reclaim of the visible epoch. Disabled keys are never removed. */
	function sweepTtl(db: Database, limit: number): SweepResult {
		const now = clock.now();
		let budget = limit;
		const spend = (n: number) => {
			budget -= n;
			return n;
		};
		const freed: string[] = [];
		let removed = 0;
		const step = (sql: string, ...params: (string | number)[]) => {
			if (budget <= 0) return;
			removed += spend(
				db.query(sql).run(...params, Math.max(1, budget)).changes,
			);
		};
		step(
			"DELETE FROM research_route_operations WHERE rowid IN (SELECT rowid FROM research_route_operations WHERE expires_at<=? LIMIT ?)",
			now,
		);
		step(
			"DELETE FROM research_search_candidates WHERE rowid IN (SELECT rowid FROM research_search_candidates WHERE expires_at<=? LIMIT ?)",
			now,
		);
		step(
			"DELETE FROM research_route_drafts WHERE rowid IN (SELECT rowid FROM research_route_drafts WHERE state IN ('activated','rejected','interrupted','superseded') AND updated_at<=? LIMIT ?)",
			now - ttl.terminalMs,
		);
		step(
			`DELETE FROM research_route_proofs WHERE rowid IN (SELECT p.rowid FROM research_route_proofs p WHERE p.expires_at<=?
			 AND NOT EXISTS(SELECT 1 FROM research_route_drafts d WHERE d.proof_id=p.id) LIMIT ?)`,
			now,
		);
		const held = heldVersions(db);
		// Superseded history: non-active, unheld, unreferenced versions older than 30 days.
		if (budget > 0) {
			const old = db
				.query(
					`SELECT r.* FROM research_route_revisions r WHERE r.created_at<=?
					 AND NOT EXISTS(SELECT 1 FROM research_route_keys k WHERE k.active_version_id=r.version_id)
					 AND NOT EXISTS(SELECT 1 FROM research_route_drafts d WHERE d.base_version_id=r.version_id)
					 LIMIT ?`,
				)
				.all(now - ttl.historyMs, budget) as repo.RevisionRow[];
			for (const r of old) {
				if (held.has(r.version_id)) continue;
				removed += spend(
					db
						.query(
							"DELETE FROM research_route_revision_health WHERE version_id=?",
						)
						.run(r.version_id).changes,
				);
				removed += spend(
					db
						.query("DELETE FROM research_route_revisions WHERE version_id=?")
						.run(r.version_id).changes,
				);
				freed.push(r.package_revision_id);
			}
		}
		// Idle keys, oldest first; under byte pressure, age no longer gates removal.
		let hasMore = false;
		if (budget > 0) {
			const epoch = repo.getEpoch(db);
			const over = () =>
				repo.ledgerBytes(db) + ext(db) >= limits.totalBytes * 0.9;
			const candidates = db
				.query(
					`SELECT * FROM research_route_keys k WHERE k.epoch=? AND k.enabled=1
					 AND NOT EXISTS(SELECT 1 FROM research_route_drafts d WHERE d.incarnation=k.incarnation AND d.state IN ('queued','authoring','reviewing'))
					 ORDER BY COALESCE(k.idle_expires_at,k.updated_at+?) ASC LIMIT 200`,
				)
				.all(epoch, ttl.idleMs) as repo.KeyRow[];
			for (const k of candidates) {
				if (budget <= 0) {
					hasMore = true;
					break;
				}
				const due = (k.idle_expires_at ?? k.updated_at + ttl.idleMs) <= now;
				if (!due && !over()) break;
				if (blocked(db, k.incarnation, held)) continue;
				const t = repo.deleteKeyTree(db, k.incarnation);
				removed += spend(t.rows);
				freed.push(...t.packageIds);
			}
		}
		if (budget <= 0) hasMore = true;
		prune(db, freed);
		return { removed, hasMore };
	}

	/** One bounded pass (default 100 rows). Safe to call repeatedly; never touches disabled keys. */
	function sweepInTransaction(
		db: Database,
		input: { mode?: SweepMode; limit?: number } = {},
	): SweepResult {
		const limit = Math.min(
			limits.sweepLimit,
			Math.max(1, input.limit ?? limits.sweepLimit),
		);
		if (input.mode === "epoch") return sweepEpoch(db, limit);
		// The periodic pass also reclaims hidden (cleared) epochs: keys that were held by a running
		// root, and clears whose own job could not be queued, are picked up here on a later pass.
		const stale = sweepEpoch(db, Math.max(1, Math.floor(limit / 2)));
		const live = sweepTtl(db, Math.max(1, limit - stale.removed));
		return {
			removed: stale.removed + live.removed,
			hasMore: stale.hasMore || live.hasMore,
		};
	}

	/** Startup: no author/review job survives a restart; interrupt every open draft. */
	function recoverInTransaction(db: Database): { interrupted: number } {
		return {
			interrupted: repo.terminateAllOpenDrafts(db, "restart", clock.now()),
		};
	}

	function enqueueSweepInTransaction(
		db: Database,
		input: { mode: SweepMode; round?: number },
	) {
		if (!opts.queue) throw new Error("maintenance_queue_unavailable");
		const round = input.round ?? 0;
		const bucket =
			input.mode === "epoch"
				? repo.getEpoch(db)
				: Math.floor(clock.now() / hour);
		opts.queue.enqueueInTransaction(db, {
			scope: ownerScope,
			kind: input.mode === "epoch" ? jobKinds.clear : jobKinds.sweep,
			payloadVersion: 1,
			dedupeKey: `${input.mode}:${bucket}:${round}`,
			payload: { mode: input.mode, round } satisfies SweepPayload,
			subjectRef: `${input.mode}:${bucket}`,
			lane: "background",
			maxAttempts: 1,
		});
	}

	const handler = (
		mode: SweepMode,
	): HandlerDefinition<SweepPayload, null, null> => ({
		kind: mode === "epoch" ? jobKinds.clear : jobKinds.sweep,
		payloadVersions: [1],
		schema: sweepPayload,
		recovery: "replay_safe",
		prepareInTransaction: (_db, claim) =>
			claim.payload.mode === mode
				? { status: "ready", input: null }
				: { status: "stale", reason: "mode_mismatch" },
		execute: async () => null,
		settleInTransaction(db, claim, _input, outcome) {
			if (outcome.type !== "success") return "applied";
			try {
				const r = sweepInTransaction(db, { mode });
				const max = mode === "ttl" ? ttlRounds : Number.MAX_SAFE_INTEGER;
				if (r.hasMore && claim.payload.round + 1 < max)
					enqueueSweepInTransaction(db, {
						mode,
						round: claim.payload.round + 1,
					});
				return "applied";
			} catch (e) {
				return {
					status: "failed",
					errorCode:
						e instanceof Error ? e.message.slice(0, 64) : "sweep_failed",
				};
			}
		},
		cancelInTransaction: () => {},
	});
	/** Both reclaim handlers; register before the runner starts. */
	const maintenanceHandlers = (): HandlerDefinition<any, any, any>[] => [
		handler("ttl"),
		handler("epoch"),
	];

	return {
		sweepInTransaction,
		recoverInTransaction,
		enqueueSweepInTransaction,
		maintenanceHandlers,
	};
}
export type Maintenance = ReturnType<typeof createMaintenance>;
