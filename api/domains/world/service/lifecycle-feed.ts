import type { Database } from "bun:sqlite";
import { type ScopeRef } from "eumenes-world-model";
import { writeExtractFeedScopeSet } from "../repository/extraction";
import {
	memoryFeedStages,
	receiveSourceChanges,
	scopeSetChanged,
	scopeSetOf,
	sourceFeedStages,
	type FeedStages,
} from "./extraction-intake";
import { sourceKeyOf } from "./inputs";
import { deletionsFirst } from "./source-adapter";
import type { ForgetReport, ConsumeReport } from "./lifecycle-types";
import {
	FEED_PAGE,
	INVALIDATE_KEYS,
	short,
	StepBlocked,
	transientReason,
	splitValidRoots,
	why,
	chunk,
	feedKeyOf,
} from "./lifecycle-shared";
import type { LifecycleCtx } from "./lifecycle-lock";
import type { ForgetOps } from "./lifecycle-forget";
import { createMemoryFeed } from "./lifecycle-feed-memory";

export function createFeedOps(ctx: LifecycleCtx, forget: ForgetOps) {
	const {
		options,
		store,
		world,
		now,
		memory,
		hook,
		adapters,
		accessFor,
		worldOp,
		acceptInWriter,
	} = ctx;
	const { advance } = forget;

	/** Stops (never deletes) the assertions that stand on these source keys. */
	function invalidateKeys(
		db: Database,
		scope: ScopeRef,
		label: string,
		keys: readonly string[],
	): number {
		let count = 0;
		for (const [index, group] of chunk(
			[...new Set(keys)],
			INVALIDATE_KEYS,
		).entries()) {
			const result = worldOp(
				db,
				scope,
				`fd:${feedKeyOf(scope, label, index)}:${short(JSON.stringify(group))}`,
				{
					kind: "invalidate",
					reasonCode: "INPUT_VERSION_INVALIDATED",
					targets: [],
					sourceKeys: group,
				},
			);
			if (result.status !== "applied" && result.status !== "no_op")
				throw new StepBlocked(`WORLD_${why(result)}`);
			count += group.length;
		}
		return count;
	}

	/** Whether this writer callback may hand extraction input to World (decided once per page). */
	function receiveUsable(
		db: Database,
	): { ok: true } | { ok: false; reason: "WORLD_OFF" | "GATE_CLOSED" } {
		if (options.gate && !options.gate.isOpen())
			return { ok: false, reason: "GATE_CLOSED" };
		return world.statusInTransaction(db).usable
			? { ok: true }
			: { ok: false, reason: "WORLD_OFF" };
	}

	/**
	 * Where each feed stands, stage by stage: the owner (is there more at the
	 * source?), the host's scan position, what World's inbox took, and what was
	 * semantically settled. Unsettled events are never reported as applied; the
	 * applied cursor stops before the oldest unsettled event.
	 */
	function feedStages(
		scope: ScopeRef,
		settings: { namespace?: string } = {},
	): FeedStages {
		const adapter = adapters.get(settings.namespace ?? "conversation");
		return store.read((db) => {
			let sourceAhead: boolean | "unknown" = "unknown";
			if (adapter) {
				const cursor = world.feedCursor(db, "source", scope);
				const scopeKeys = scopeSetOf(options.scopes ?? [], scope);
				try {
					const head = adapter.listChanges(db, accessFor(db, scope), {
						cursor: scopeSetChanged(db, "source", scope, scopeKeys)
							? null
							: cursor.cursor,
						limit: 1,
					});
					sourceAhead = head.changes.length > 0 || head.hasMore;
				} catch {
					sourceAhead = "unknown";
				}
			}
			let memoryAhead: boolean | "unknown" = "unknown";
			const memoryCursor = world.feedCursor(db, "memory", scope);
			const memoryKeys = scopeSetOf(options.scopes ?? [], scope);
			const after = scopeSetChanged(db, "memory", scope, memoryKeys)
				? 0
				: memoryCursor.cursor === null
					? 0
					: Number(memoryCursor.cursor);
			if (Number.isSafeInteger(after) && after >= 0) {
				try {
					const page = memory.listChanges(db, accessFor(db, scope), {
						scopeKey: scope.scopeKey,
						afterSeq: after,
						limit: 1,
					});
					if (page.status === "ok")
						memoryAhead = page.changes.length > 0 || page.hasMore;
				} catch {
					memoryAhead = "unknown";
				}
			}
			return {
				source: sourceFeedStages(db, scope, sourceAhead),
				memory: memoryFeedStages(db, scope, memoryAhead),
			};
		});
	}

	/**
	 * Reads the conversation outbox (SourceAdapter.listChanges) from its own
	 * persisted cursor. Deletions and retractions are applied before additions
	 * and corrections (deletionsFirst): a retraction becomes a forget intake, a
	 * correction stops the assertions that stand on the old version, and every
	 * remaining user addition or correction is handed to World's inbox
	 * (`inbox.receive`, P4-01) once those two are applied. The receipts and the
	 * cursor move in the same writer callback; the semantic application
	 * (extraction, `candidate.settle`) is a separate, later step.
	 */
	async function consumeSourceChanges(
		scope: ScopeRef,
		settings: { namespace?: string; limit?: number } = {},
	): Promise<ConsumeReport> {
		const adapter = adapters.get(settings.namespace ?? "conversation");
		if (!adapter)
			return {
				resync: false,
				changes: 0,
				forgets: [],
				invalidated: 0,
				hasMore: false,
				blocked: "SOURCE_ADAPTER_MISSING",
				rejectedRoots: 0,
			};
		let out: {
			resync: boolean;
			changes: number;
			intakes: string[];
			invalidated: number;
			hasMore: boolean;
			rejectedRoots: number;
			received: number;
			skipped: number;
		};
		try {
			out = await store.write((db) => {
				const cursor = world.feedCursor(db, "source", scope);
				// A different Scope set discards the cursor: the feed is read again.
				const scopeKeys = scopeSetOf(options.scopes ?? [], scope);
				const widened = scopeSetChanged(db, "source", scope, scopeKeys);
				const access = accessFor(db, scope);
				const page = adapter.listChanges(db, access, {
					cursor: widened ? null : cursor.cursor,
					limit: Math.min(settings.limit ?? FEED_PAGE, FEED_PAGE),
				});
				const ordered = deletionsFirst(
					page.changes.filter(
						(c) =>
							c.principal === scope.principal && c.scopeKey === scope.scopeKey,
					),
				);
				const intakes: string[] = [];
				const retracted = ordered.filter((c) => c.kind === "retracted");
				const split = splitValidRoots(
					retracted.map((c) => ({
						kind: "source" as const,
						id: sourceKeyOf(c.source),
						revision: 1,
					})),
				);
				if (split.valid.length > 0) {
					const forgetId = `sf-${feedKeyOf(scope, "source", page.nextCursor)}`;
					const accepted = acceptInWriter(db, {
						forgetId,
						scope,
						reasonCode: "SOURCE_FORGOTTEN",
						roots: split.valid,
						origin: "source_feed",
					});
					if ("status" in accepted)
						throw new StepBlocked(`INTAKE_${accepted.reasonCode}`);
					intakes.push(forgetId);
				}
				const corrected = ordered
					.filter((c) => c.kind === "corrected")
					.map((c) => sourceKeyOf(c.source));
				const invalidated =
					corrected.length === 0
						? 0
						: invalidateKeys(db, scope, `src:${page.nextCursor}`, corrected);
				// Corrections and forgets above come first; only then are the
				// remaining additions persisted as extraction input (P4-01). The
				// receipt and the cursor save are ONE writer callback: if it fails
				// (database, Writer) nothing of it remains and the cursor stays.
				const state = receiveUsable(db);
				const receipt = receiveSourceChanges(
					db,
					{ worldOp, usable: () => state, now },
					scope,
					{ scopeKeys, restoreEpoch: cursor.restoreEpoch },
					ordered,
				);
				world.saveFeedCursorInWriter(db, "source", scope, page.nextCursor);
				writeExtractFeedScopeSet(
					db,
					"source",
					scope.principal,
					scope.scopeKey,
					JSON.stringify(scopeKeys),
				);
				hook("feed_cursor_saved");
				return {
					resync: cursor.stale || widened,
					changes: page.changes.length,
					intakes,
					invalidated,
					hasMore: page.hasMore,
					rejectedRoots: split.rejected,
					received: receipt.received,
					skipped: receipt.skipped,
				};
			});
		} catch (error) {
			const reason = transientReason(error);
			if (reason === null) throw error;
			return {
				resync: false,
				changes: 0,
				forgets: [],
				invalidated: 0,
				hasMore: false,
				blocked: reason,
				rejectedRoots: 0,
			};
		}
		const forgets: ForgetReport[] = [];
		for (const id of out.intakes) forgets.push(await advance(id));
		return {
			resync: out.resync,
			changes: out.changes,
			forgets,
			invalidated: out.invalidated,
			hasMore: out.hasMore,
			blocked: null,
			rejectedRoots: out.rejectedRoots,
			received: out.received,
			skippedInputs: out.skipped,
		};
	}

	return {
		feedStages,
		consumeMemoryChanges: createMemoryFeed(ctx, forget, { invalidateKeys })
			.consumeMemoryChanges,
		consumeSourceChanges,
	};
}
export type FeedHelpers = {
	invalidateKeys: (
		db: Database,
		scope: ScopeRef,
		label: string,
		keys: readonly string[],
	) => number;
};
