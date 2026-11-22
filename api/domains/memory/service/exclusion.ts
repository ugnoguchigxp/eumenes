import type { Database } from "bun:sqlite";
import { LIMITS_LIFECYCLE } from "eumenes-memory";
import type { AccessContext } from "eumenes-memory";
import {
	applyExclusion,
	planExclusion,
	readCandidate,
	type ExclusionTarget as LibraryTarget,
	type StateItem,
} from "eumenes-memory/sqlite";
import { FORGET_MAX_ITEMS, PROFILE_SCOPE } from "../contracts";
import type {
	ExcludeForForgetInput,
	ExcludeForForgetOutcome,
} from "../contracts/immediate";
import { bumpForgetSeq } from "../repository";
import type { createForget } from "./forget";
import {
	everyItem,
	itemOf,
	rejected,
	resolveTarget,
	type ImmediateDeps,
} from "./immediate-shared";
import { candidatesOfFacts, factKey } from "./candidate-closure";
import { appendJournal } from "./journal";

const hasText = (value: unknown): value is string =>
	typeof value === "string" && value.trim() !== "";

/**
 * The immediate stage of a forget (section 9.2): what the user asked to forget is excluded at once, in the same
 * transaction, and the exclusion is a line of the forget journal (so a restore of an older database replays it).
 * The closure delete (`forget.ts`) follows and removes the versions and what was derived from them; when it
 * tombstones an item the library drops its exclusion too.
 */
export function createExclusion(
	deps: ImmediateDeps & {
		journalPath: string;
		access: (db: Database, purpose: string) => AccessContext;
		forgetter: Pick<ReturnType<typeof createForget>, "expandItems">;
	},
) {
	const { windows } = deps;

	/**
	 * Excludes the targets: for an item, every version of its fact and the merge lineage (what `forget` would remove);
	 * with them, the candidates of those facts. `onJournaled` is told before each journal line is written.
	 */
	function exclude(
		db: Database,
		input: ExcludeForForgetInput,
		onJournaled: () => void,
	): ExcludeForForgetOutcome {
		if (!deps.ready()) return rejected("memory_unavailable");
		if (
			!hasText(input.conversationId) ||
			!hasText(input.sourceRunId) ||
			!Array.isArray(input.targets) ||
			input.targets.length === 0
		)
			return rejected("invalid_input");
		if (input.targets.length > FORGET_MAX_ITEMS)
			return rejected("limit_reached");
		// Everything is checked before anything is written: a refused request changes nothing.
		const requested = new Set<string>();
		const candidateIds = new Set<string>();
		for (const target of input.targets) {
			if ("candidateId" in target) {
				if (!hasText(target.candidateId)) return rejected("invalid_input");
				const read = readCandidate(db, {
					...deps.scoped(db, "memory.forget"),
					candidateId: target.candidateId,
				});
				if (read.status !== "ok") return rejected("target_missing");
				candidateIds.add(target.candidateId);
				continue;
			}
			const resolved = resolveTarget(db, deps, input.conversationId, target);
			if (!resolved.ok) return rejected(resolved.reason);
			const found = itemOf(db, deps, resolved.itemId);
			if (!found) return rejected("target_missing");
			if (resolved.revision !== null && found.revision !== resolved.revision)
				return rejected("target_changed");
			requested.add(found.itemId);
		}
		const itemIds = new Set<string>();
		deps.forgetter.expandItems(db, requested, itemIds, true);
		const items = everyItem(db, deps).filter((item) =>
			itemIds.has(item.itemId),
		);
		const facts = new Set(items.map(factKey));
		for (const candidate of candidatesOfFacts(
			db,
			deps.access(db, "memory.forget"),
			facts,
			itemIds,
		))
			candidateIds.add(candidate.candidateId);
		const evidenceMessageIds = [
			...new Set(
				items.flatMap((item: StateItem) =>
					item.evidence
						.filter((ref) => ref.namespace === "conversation")
						.map((ref) => ref.id),
				),
			),
		];
		const targets: LibraryTarget[] = [
			...[...itemIds].map((itemId) => ({
				type: "state_item" as const,
				itemId,
				scopeKey: PROFILE_SCOPE,
			})),
			...[...candidateIds].map((candidateId) => ({
				type: "candidate" as const,
				candidateId,
				scopeKey: PROFILE_SCOPE,
			})),
		];
		const max = LIMITS_LIFECYCLE.maxJournalTargets;
		let journaled = 0;
		for (let from = 0; from < targets.length; from += max) {
			const planned = planExclusion(db, {
				contractVersion: 2,
				access: deps.access(db, "memory.forget"),
				op: "exclude",
				targets: targets.slice(from, from + max),
				clock: { atMs: deps.atMs() },
			});
			if (planned.status !== "planned") throw new Error("memory_blocked");
			// Already excluded: nothing to journal (a line for it would change no state).
			if (planned.plan.affected === 0) continue;
			onJournaled();
			appendJournal(deps.journalPath, planned.plan.entry);
			applyExclusion(db, {
				contractVersion: 2,
				entry: planned.plan.entry,
				clock: { atMs: deps.atMs() },
				sourceRunId: input.sourceRunId,
			});
			journaled++;
		}
		// A steward result built before this must not be adopted (the same fence the closure delete moves).
		bumpForgetSeq(db);
		windows.recordImmediateInTransaction(
			db,
			"state_exclude",
			input.sourceRunId,
		);
		// The rendered windows still hold the text.
		windows.purgeInTransaction(db);
		return {
			status: "applied",
			itemIds: [...itemIds],
			candidateIds: [...candidateIds],
			evidenceMessageIds,
			journaled,
		};
	}

	return { exclude };
}
