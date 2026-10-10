import { type MemoryChange } from "eumenes-memory";
import { type ScopeRef } from "eumenes-world-model";
import { getIntake, type ForgetRoot } from "../repository/lifecycle";
import { writeExtractFeedScopeSet } from "../repository/extraction";
import { scopeSetChanged, scopeSetOf } from "./extraction-intake";
import type { ForgetReport, ConsumeReport } from "./lifecycle-types";
import {
	FEED_PAGE,
	FEED_MAX_ROWS,
	StepBlocked,
	transientReason,
	rootDigest,
	rootsCover,
	normalizeRoots,
	splitValidRoots,
	stateItemKey,
	recordKey,
	feedForgetId,
	memoryRoot,
	STOPPED,
} from "./lifecycle-shared";
import type { LifecycleCtx } from "./lifecycle-lock";
import type { ForgetOps } from "./lifecycle-forget";
import type { FeedHelpers } from "./lifecycle-feed";

export function createMemoryFeed(
	ctx: LifecycleCtx,
	forget: ForgetOps,
	feed: FeedHelpers,
) {
	const { options, store, world, memory, hook, accessFor, acceptInWriter } =
		ctx;
	const { advance } = forget;
	const { invalidateKeys } = feed;

	/**
	 * Reads Memory's change feed from the persisted cursor (valid only for the
	 * current restore epoch; a stale cursor re-reads everything). In ONE writer
	 * callback: "forgotten" notifications become durable forget intakes,
	 * other status changes invalidate World items, and the cursor moves.
	 * Forgets are then driven to completion (World deletion needs no model,
	 * no World ON and no Memory).
	 */
	async function consumeMemoryChanges(
		scope: ScopeRef,
		settings: { limit?: number } = {},
	): Promise<ConsumeReport> {
		const limit = Math.min(settings.limit ?? FEED_PAGE, FEED_PAGE);
		let out: {
			resync: boolean;
			changes: number;
			intakes: string[];
			invalidated: number;
			hasMore: boolean;
			rejectedRoots: number;
		};
		try {
			out = await store.write((db) => {
				const cursor = world.feedCursor(db, "memory", scope);
				// A different Scope set discards the cursor: the feed is read again.
				const scopeKeys = scopeSetOf(options.scopes ?? [], scope);
				const widened = scopeSetChanged(db, "memory", scope, scopeKeys);
				const afterSeq =
					widened || cursor.cursor === null ? 0 : Number(cursor.cursor);
				if (!Number.isSafeInteger(afterSeq) || afterSeq < 0)
					throw new StepBlocked("FEED_CURSOR_INVALID");
				const access = accessFor(db, scope);
				const rows: MemoryChange[] = [];
				let position = afterSeq;
				let hasMore = false;
				let cut = false;
				for (let first = true; ; first = false) {
					const page = memory.listChanges(db, access, {
						scopeKey: scope.scopeKey,
						afterSeq: position,
						limit: first ? limit : FEED_PAGE,
					});
					if (page.status !== "ok")
						throw new StepBlocked("MEMORY_FEED_BLOCKED");
					let taken = [...page.changes];
					let next = page.nextAfterSeq;
					hasMore = page.hasMore;
					let split = -1;
					if (!first) {
						// Only the forget run the previous page ended in continues here.
						const run = rows[rows.length - 1]!.forgetId;
						split = taken.findIndex((c) => c.forgetId !== run);
						if (split >= 0) {
							taken = taken.slice(0, split);
							next =
								taken.length === 0 ? position : taken[taken.length - 1]!.seq;
							hasMore = true;
						}
					}
					rows.push(...taken);
					position = next;
					if (split >= 0) break;
					const last = rows[rows.length - 1];
					if (!hasMore || last === undefined || last.forgetId === null) break;
					if (rows.length >= FEED_MAX_ROWS) {
						cut = true;
						break;
					}
				}
				// Forgets: one intake per Memory forgetId in this batch.
				const groups = new Map<string, ForgetRoot[]>();
				const lastStatus = new Map<string, { status: string; key: string }>();
				for (const change of rows) {
					if (change.status === "forgotten") {
						const root = memoryRoot(change);
						if (root === null) continue;
						const id = change.forgetId ?? `unnamed-${rows[0]!.seq}`;
						const list = groups.get(id) ?? [];
						list.push(root);
						groups.set(id, list);
					} else if (change.targetType !== "source") {
						const key =
							change.targetType === "state_item"
								? stateItemKey(change.targetId)
								: recordKey(change.targetId);
						lastStatus.set(`${change.targetType}:${change.targetId}`, {
							status: change.status,
							key,
						});
					}
				}
				const firstSeq = rows[0]?.seq ?? 0;
				const lastForget = rows[rows.length - 1]?.forgetId ?? null;
				const intakes: string[] = [];
				let rejectedRoots = 0;
				for (const [memoryForgetId, allRoots] of groups) {
					// Ids World would refuse are counted and skipped; they must not
					// keep the cursor (and every other root) from moving.
					const split = splitValidRoots(allRoots);
					rejectedRoots += split.rejected;
					if (split.valid.length === 0) continue;
					// Deduplicated first: both sides of the digest comparison are the
					// stored (deduplicated) form.
					const roots = normalizeRoots(split.valid);
					if ("status" in roots)
						throw new StepBlocked(`INTAKE_${roots.reasonCode}`);
					const final = !(cut && memoryForgetId === lastForget);
					let forgetId = feedForgetId(memoryForgetId);
					const existing = getIntake(db, forgetId);
					if (
						existing &&
						existing.rootsDigest !== rootDigest(roots) &&
						!rootsCover(existing, roots)
					)
						forgetId = feedForgetId(`${memoryForgetId}#${firstSeq}`);
					const accepted = acceptInWriter(
						db,
						{
							forgetId,
							scope,
							reasonCode: "SOURCE_FORGOTTEN",
							roots,
							memoryForgetId,
							origin: "memory_feed",
						},
						{ memoryFinal: final },
					);
					if ("status" in accepted)
						throw new StepBlocked(`INTAKE_${accepted.reasonCode}`);
					intakes.push(forgetId);
				}
				const stopped = [...lastStatus.values()]
					.filter((v) => STOPPED.has(v.status))
					.map((v) => v.key);
				const invalidated =
					stopped.length === 0
						? 0
						: invalidateKeys(db, scope, `mem:${firstSeq}:${position}`, stopped);
				world.saveFeedCursorInWriter(db, "memory", scope, String(position));
				writeExtractFeedScopeSet(
					db,
					"memory",
					scope.principal,
					scope.scopeKey,
					JSON.stringify(scopeKeys),
				);
				hook("feed_cursor_saved");
				return {
					resync: cursor.stale || widened,
					changes: rows.length,
					intakes,
					invalidated,
					hasMore,
					rejectedRoots,
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
		};
	}

	return { consumeMemoryChanges };
}
