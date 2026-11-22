import type { Database } from "bun:sqlite";
import { classifyValidity, periodFromStateMs } from "eumenes-memory";
import { assertUserState, type StateItem } from "eumenes-memory/sqlite";
import type {
	CorrectExplicitInput,
	CorrectExplicitOutcome,
	ImmediateRejection,
	RememberExplicitInput,
	RememberExplicitOutcome,
} from "../contracts/immediate";
import {
	MAX_ACTIVE_ITEMS,
	MAX_TEXT_CHARS,
	isStateKind,
} from "./curation-shared";
import { validityBounds, type ValidityBounds } from "./curation-evidence";
import { insertExplicitRequest } from "../repository/immediate";
import { putProvenance } from "../repository";
import {
	everyItem,
	groundedEvidence,
	guarded,
	itemOf,
	rejected,
	resolveTarget,
	writeRejection,
	type ImmediateDeps,
} from "./immediate-shared";
import { normalizeKey } from "./quote";

type Fields = {
	text: string;
	polarity: "affirmed" | "negated";
	validity: ValidityBounds;
};

/** The words of a new version as stored: trimmed, bounded, with its stated validity. */
function checkedFields(input: {
	text: string;
	polarity: "affirmed" | "negated";
	validFrom?: string | null;
	validUntil?: string | null;
}): Fields | ImmediateRejection {
	if (typeof input.text !== "string") return "invalid_input";
	const text = input.text.trim();
	if (text === "" || [...text].length > MAX_TEXT_CHARS) return "invalid_input";
	if (input.polarity !== "affirmed" && input.polarity !== "negated")
		return "invalid_input";
	const validity = validityBounds(input);
	if (validity === "invalid") return "invalid_validity";
	return { text, polarity: input.polarity, validity };
}

const sameValue = (item: StateItem, fields: Fields) =>
	item.value.text === fields.text &&
	item.value.polarity === fields.polarity &&
	Object.keys(item.value.attributes ?? {}).length === 0;

const hasText = (value: unknown): value is string =>
	typeof value === "string" && value.trim() !== "";

/**
 * "Remember this" and what the user said of themselves (sections 5.1 and 4.2): saved at once, `user_confirmed`, only
 * when the quote stands in the user's own message. A correction replaces the version the user named (`replaces`,
 * `change: "correction"`); every version carries the run that made it, so the run's own change never expires it.
 * Whether the information is too sensitive to keep unasked is the caller's decision.
 */
export function createExplicitOps(deps: ImmediateDeps) {
	const { windows, clock } = deps;

	/** The write of one version, plus what is recorded around it (provenance, the request, the window). */
	function save(
		db: Database,
		input: {
			conversationId: string;
			sourceRunId: string;
			messageId: string;
			quote: string;
			requested: boolean;
			op: "remember" | "correct";
			kind: StateItem["kind"];
			semanticKey: string;
			fields: Fields;
			replaces: StateItem | null;
			/** The same value is stored already: the library only confirms it in place, no new version. */
			inPlace: boolean;
		},
	):
		| {
				ok: true;
				item: StateItem;
				changed: boolean;
				requestId: string | null;
		  }
		| { ok: false; reason: ImmediateRejection } {
		const grounded = groundedEvidence(db, deps, {
			conversationId: input.conversationId,
			messageId: input.messageId,
			quote: input.quote,
			hint: input.fields.text,
		});
		if (!grounded.ok) return { ok: false, reason: grounded.reason };
		const { built } = grounded;
		const { fields } = input;
		const result = assertUserState(db, {
			...deps.scoped(db, "memory.write"),
			clock: { atMs: deps.atMs() },
			kind: input.kind,
			subject: "self",
			semanticKey: input.semanticKey,
			value: { text: fields.text, polarity: fields.polarity },
			evidence: [
				{ source: built.evidence.source, quote: built.evidence.quote },
			],
			sources: [built.source],
			origin: "user_confirmed",
			...(fields.validity && fields.validity !== "invalid"
				? { validity: fields.validity }
				: {}),
			...(input.replaces
				? {
						replaces: {
							itemId: input.replaces.itemId,
							revision: input.replaces.revision,
						},
						change: "correction" as const,
					}
				: {}),
			sourceRunId: input.sourceRunId,
		});
		if (result.status !== "applied" && result.status !== "unchanged")
			return { ok: false, reason: writeRejection(result) };
		const changed = result.status === "applied";
		let requestId: string | null = null;
		if (changed) {
			// An item confirmed in place keeps its id: who asked is recorded, but there is no new version to withdraw.
			if (!input.inPlace || input.requested)
				putProvenance(
					db,
					result.item.itemId,
					input.sourceRunId,
					input.requested ? "request" : "agent",
					clock(),
					true,
				);
			if (!input.inPlace) {
				requestId = deps.id();
				insertExplicitRequest(
					db,
					{
						requestId,
						requested: input.requested,
						conversationId: input.conversationId,
						runId: input.sourceRunId,
						op: input.op,
						itemId: result.item.itemId,
						itemRevision: result.item.revision,
						replacedItemId: input.replaces?.itemId ?? null,
					},
					clock(),
				);
			}
			// What the user replaced must not stay in the published profile beside its new version (section 13);
			// a version that is only added waits for the next re-construction.
			if (input.replaces)
				windows.recordImmediateInTransaction(
					db,
					"state_correct",
					input.sourceRunId,
				);
		}
		return { ok: true, item: result.item, changed, requestId };
	}

	function remember(
		db: Database,
		input: RememberExplicitInput,
	): RememberExplicitOutcome {
		if (!deps.ready()) return rejected("memory_unavailable");
		if (
			!hasText(input.conversationId) ||
			!hasText(input.sourceRunId) ||
			!hasText(input.messageId) ||
			input.subject !== "self" ||
			!isStateKind(input.kind)
		)
			return rejected("invalid_input");
		const key = normalizeKey(input.semanticKey);
		if (key === null) return rejected("invalid_key");
		const fields = checkedFields(input);
		if (typeof fields === "string") return rejected(fields);
		if (!hasText(input.quote)) return rejected("quote_mismatch");
		return guarded(db, (): RememberExplicitOutcome => {
			const listed = everyItem(db, deps);
			const ofFact = listed.filter(
				(item) =>
					item.kind === input.kind &&
					item.subject === "self" &&
					item.semanticKey === key,
			);
			// Saying it again while the fact is being forgotten would stand beside the version the forget removes.
			if (ofFact.some((item) => item.excluded === true))
				return rejected("forget_pending");
			const active = ofFact.find((item) => item.status === "active");
			const now = deps.atMs();
			const counted = listed.filter(
				(item) =>
					item.excluded !== true &&
					item.status === "active" &&
					classifyValidity(
						periodFromStateMs(item.validFromMs, item.validUntilMs),
						now,
					) !== "past",
			).length;
			if (counted >= MAX_ACTIVE_ITEMS && !active)
				return rejected("limit_reached");
			const same = active !== undefined && sameValue(active, fields);
			// What the user stated unasked never replaces a record that stands (a contradiction is not settled by
			// itself, section 6.2): the one who asks has the user's word on it.
			if (input.requested === false && active && !same)
				return {
					status: "rejected",
					reason: "conflict",
					existingId: active.itemId,
				};
			const saved = save(db, {
				conversationId: input.conversationId,
				sourceRunId: input.sourceRunId,
				messageId: input.messageId,
				quote: input.quote,
				requested: input.requested !== false,
				op: "remember",
				kind: input.kind,
				semanticKey: key,
				fields,
				// The same value is never "replaced": the library confirms the version in place (an inference becomes the user's).
				replaces: active && !same ? active : null,
				inPlace: same,
			});
			if (!saved.ok) return rejected(saved.reason);
			if (!saved.changed)
				return {
					status: "unchanged",
					itemId: saved.item.itemId,
					revision: saved.item.revision,
				};
			return {
				status: "applied",
				requestId: saved.requestId,
				itemId: saved.item.itemId,
				revision: saved.item.revision,
				replacedItemId: active && !same ? active.itemId : null,
			};
		});
	}

	function correct(
		db: Database,
		input: CorrectExplicitInput,
	): CorrectExplicitOutcome {
		if (!deps.ready()) return rejected("memory_unavailable");
		if (
			!hasText(input.conversationId) ||
			!hasText(input.sourceRunId) ||
			!hasText(input.messageId)
		)
			return rejected("invalid_input");
		const fields = checkedFields(input);
		if (typeof fields === "string") return rejected(fields);
		if (!hasText(input.quote)) return rejected("quote_mismatch");
		return guarded(db, (): CorrectExplicitOutcome => {
			const target = resolveTarget(
				db,
				deps,
				input.conversationId,
				input.target,
			);
			if (!target.ok) return rejected(target.reason);
			const found = itemOf(db, deps, target.itemId);
			if (!found) return rejected("target_missing");
			if (found.excluded === true) return rejected("target_excluded");
			if (
				found.status !== "active" ||
				found.subject !== "self" ||
				!isStateKind(found.kind) ||
				(target.revision !== null && found.revision !== target.revision)
			)
				return rejected("target_changed");
			if (sameValue(found, fields))
				return {
					status: "unchanged",
					itemId: found.itemId,
					revision: found.revision,
				};
			const saved = save(db, {
				conversationId: input.conversationId,
				sourceRunId: input.sourceRunId,
				messageId: input.messageId,
				quote: input.quote,
				requested: input.requested !== false,
				op: "correct",
				kind: found.kind,
				semanticKey: found.semanticKey,
				fields,
				replaces: found,
				inPlace: false,
			});
			if (!saved.ok) return rejected(saved.reason);
			return {
				status: "applied",
				requestId: saved.requestId as string,
				itemId: saved.item.itemId,
				revision: saved.item.revision,
				replacedItemId: found.itemId,
			};
		});
	}

	return { remember, correct };
}
