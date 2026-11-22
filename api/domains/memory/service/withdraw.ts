import type { Database } from "bun:sqlite";
import {
	assertUserState,
	retractState,
	type StateItem,
} from "eumenes-memory/sqlite";
import type {
	ImmediateRejection,
	WithdrawExplicitInput,
	WithdrawExplicitOutcome,
} from "../contracts/immediate";
import { provenanceOf, putProvenance } from "../repository";
import {
	appliedRequestOfItem,
	latestAppliedRequest,
	markRequestWithdrawn,
	readExplicitRequest,
	type ExplicitRequestRow,
} from "../repository/immediate";
import { MAX_EVIDENCE } from "./curation-shared";
import {
	guarded,
	itemOf,
	rejected,
	resolveTarget,
	writeRejection,
	type ImmediateDeps,
} from "./immediate-shared";

const hasText = (value: unknown): value is string =>
	typeof value === "string" && value.trim() !== "";

/** The library's origin vocabulary for a version that is brought back. */
const restoredOrigin = (origin: StateItem["origin"]) =>
	origin === "user_confirmed" || origin === "user_edited"
		? origin
		: ("agent_inferred" as const);

export function createWithdraw(deps: ImmediateDeps) {
	const { windows, clock } = deps;

	/** Which applied request a withdrawal names. */
	function requestOf(
		db: Database,
		input: WithdrawExplicitInput,
	): ExplicitRequestRow | ImmediateRejection {
		const { target } = input;
		if (!target)
			return (
				latestAppliedRequest(db, input.conversationId) ?? "nothing_to_withdraw"
			);
		if ("requestId" in target) {
			const row = hasText(target.requestId)
				? readExplicitRequest(db, target.requestId)
				: null;
			return row &&
				row.conversationId === input.conversationId &&
				row.state === "applied"
				? row
				: "nothing_to_withdraw";
		}
		const resolved = resolveTarget(db, deps, input.conversationId, target);
		if (!resolved.ok) return resolved.reason;
		const item = itemOf(db, deps, resolved.itemId);
		// A forget is never withdrawn; neither is anything that is on its way to being forgotten.
		if (item?.excluded === true) return "forget_not_withdrawable";
		return (
			appliedRequestOfItem(db, input.conversationId, resolved.itemId) ??
			(item ? "nothing_to_withdraw" : "target_missing")
		);
	}

	/**
	 * Takes back what an applied "remember" or correction did, in the same conversation: the saved version is retracted
	 * and, for a correction, the version it replaced comes back (as a new version standing on the old evidence: the
	 * library never reopens a replaced one). A forget is not withdrawn (existing rule).
	 */
	function withdraw(
		db: Database,
		input: WithdrawExplicitInput,
	): WithdrawExplicitOutcome {
		if (!deps.ready()) return rejected("memory_unavailable");
		if (!hasText(input.conversationId) || !hasText(input.sourceRunId))
			return rejected("invalid_input");
		if (input.ofForget === true) return rejected("forget_not_withdrawable");
		return guarded(db, (): WithdrawExplicitOutcome => {
			const row = requestOf(db, input);
			if (typeof row === "string") return rejected(row);
			const saved = itemOf(db, deps, row.itemId);
			if (!saved) return rejected("target_missing");
			if (saved.excluded === true) return rejected("forget_not_withdrawable");
			// Changed since (corrected again, stopped, confirmed anew): the request is no longer what stands.
			if (saved.status !== "active" || saved.revision !== row.itemRevision)
				return rejected("target_changed");
			const retracted = retractState(db, {
				...deps.scoped(db, "memory.write"),
				clock: { atMs: deps.atMs() },
				itemId: saved.itemId,
				expectedRevision: saved.revision,
				sourceRunId: input.sourceRunId,
			});
			if (retracted.status !== "applied")
				return rejected(
					retracted.status === "rejected" &&
						retracted.reasonCode === "STALE_REVISION"
						? "target_changed"
						: "conflict",
				);
			let restoredItemId: string | null = null;
			const old = row.replacedItemId
				? itemOf(db, deps, row.replacedItemId)
				: null;
			if (old && old.excluded !== true) {
				const usable = deps.evidence
					.usableEvidence(db, old)
					.slice(0, MAX_EVIDENCE);
				if (usable.length === 0) return rejected("cannot_restore");
				const restored = assertUserState(db, {
					...deps.scoped(db, "memory.write"),
					clock: { atMs: deps.atMs() },
					kind: old.kind,
					subject: old.subject,
					semanticKey: old.semanticKey,
					value: old.value,
					evidence: usable.map((entry) => ({
						source: entry.evidence.source,
						quote: entry.evidence.quote,
					})),
					sources: usable.map((entry) => entry.host),
					origin: restoredOrigin(old.origin),
					...(old.validity
						? { validity: old.validity }
						: {
								...(old.validFromMs === null
									? {}
									: { validFromMs: old.validFromMs }),
								...(old.validUntilMs === null
									? {}
									: { validUntilMs: old.validUntilMs }),
							}),
					sourceRunId: input.sourceRunId,
				});
				if (restored.status !== "applied" && restored.status !== "unchanged")
					return rejected(writeRejection(restored));
				restoredItemId = restored.item.itemId;
				putProvenance(
					db,
					restoredItemId,
					input.sourceRunId,
					provenanceOf(db, old.itemId),
					clock(),
					true,
				);
			}
			markRequestWithdrawn(db, row.requestId, restoredItemId, clock());
			// The retracted version leaves the published profile at once.
			windows.recordImmediateInTransaction(
				db,
				"state_retract",
				input.sourceRunId,
			);
			return {
				status: "applied",
				requestId: row.requestId,
				retractedItemId: saved.itemId,
				restoredItemId,
			};
		});
	}

	return { withdraw };
}
