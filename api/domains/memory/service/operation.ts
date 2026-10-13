import type { Database } from "bun:sqlite";
import { MemoryContractError } from "eumenes-memory";
import { getLogger } from "../../../infrastructure/logger";
import type { StateItem } from "eumenes-memory/sqlite";
import { stateKinds, type MemoryItemDto, type Remember } from "../contracts";
import type { ConversationService } from "../../conversation";
import type { ContinuityService } from "../../continuity";
import {
	countActiveTendencies,
	getTendency,
	isExcluded,
	insertTendency,
	putProvenance,
	retireTendency,
	updateTendency,
	type TendencyEvidence,
} from "../repository";
import { noteKinds, type AgentOp } from "./agent-schema";
import { foldedLength, locateQuote, sharesBigram } from "./quote";
import { parseDatePart } from "./validity";

export type AgentTurn = {
	label: string;
	messageId: string;
	runId: string | null;
	role: "user" | "assistant";
	text: string;
	createdAt: string;
};
/** "m1" -> a State item, "n1" -> a short-term note, "t1" -> a tendency; fixed when the agent was prepared. */
export type AgentRefs = Record<
	string,
	{
		namespace: "state" | "continuity" | "tendency";
		id: string;
		revision: number;
	}
>;
export type AgentReason =
	| "quote_mismatch"
	| "unknown_ref"
	| "item_changed"
	| "limit_reached"
	| "invalid_input"
	| "conflict"
	| "user_stopped"
	| "user_protected";
export type AgentOpResult =
	| { status: "applied" }
	| {
			status: "rejected";
			reason: AgentReason;
			/** `user_protected` only: the text of the user's own item the inference disagreed with. */
			protectedText?: string;
	  };

const log = getLogger("memory");
const MAX_ACTIVE_TENDENCIES = 20;
const MAX_TENDENCY_CHARS = 120;
const applied: AgentOpResult = { status: "applied" };
const rejected = (reason: AgentReason): AgentOpResult => ({
	status: "rejected",
	reason,
});
const isStateKind = (kind: string | undefined): kind is Remember["kind"] =>
	(stateKinds as readonly string[]).includes(kind ?? "");
const isNoteKind = (
	kind: string | undefined,
): kind is (typeof noteKinds)[number] =>
	(noteKinds as readonly string[]).includes(kind ?? "");

/** A thrown library or host error as an op refusal; null for anything unexpected (the job fails then). */
function reasonOf(error: unknown): AgentReason | null {
	if (error instanceof MemoryContractError) return "invalid_input";
	switch (error instanceof Error ? error.message : "") {
		case "invalid_memory_quote":
			return "quote_mismatch";
		case "invalid_memory_limit":
		case "invalid_continuity_limit":
			return "limit_reached";
		case "invalid_memory_source":
		case "invalid_memory_input":
			return "invalid_input";
		case "invalid_memory_write":
		case "invalid_memory_transition":
		case "invalid_memory_item":
		case "revision_conflict":
			return "conflict";
		default:
			return null;
	}
}

const turnOf = (ctx: { turns: AgentTurn[] }, label: string | undefined) =>
	ctx.turns.find((turn) => turn.label === label);
const refOf = (
	ctx: { refs: AgentRefs },
	label: string | undefined,
	namespace: AgentRefs[string]["namespace"],
) => {
	const ref = label === undefined ? undefined : ctx.refs[label];
	return ref && ref.namespace === namespace ? ref : undefined;
};

/**
 * Why an inference (written without being asked) must not touch this fact, or null. What the user switched off
 * stays off; what they confirmed or edited is not replaced by a different value (they are told, so they can say it again).
 */
function inferenceRefusal(
	items: readonly StateItem[],
	kind: string,
	semanticKey: string,
	op: AgentOp,
): AgentOpResult | null {
	const sameFact = items.filter(
		(item) =>
			item.subject === "self" &&
			item.kind === kind &&
			item.semanticKey === semanticKey,
	);
	if (sameFact.some((i) => i.status === "inactive" || i.status === "retracted"))
		return rejected("user_stopped");
	const text = (op.text ?? "").trim();
	const confirmed = sameFact.find(
		(item) =>
			item.status === "active" &&
			(item.origin === "user_confirmed" || item.origin === "user_edited") &&
			(item.value.text !== text ||
				item.value.polarity !== (op.polarity ?? "affirmed") ||
				Object.keys(item.value.attributes ?? {}).length > 0),
	);
	return confirmed
		? {
				status: "rejected",
				reason: "user_protected",
				protectedText: confirmed.value.text,
			}
		: null;
}

/** The date text of a validity bound, as the library's precision-carrying date. */
function validityOf(op: AgentOp): Remember["validity"] | null | "invalid" {
	if (op.validFrom === undefined && op.validUntil === undefined) return null;
	const from =
		op.validFrom === undefined ? undefined : parseDatePart(op.validFrom);
	const until =
		op.validUntil === undefined ? undefined : parseDatePart(op.validUntil);
	if (from === null || until === null) return "invalid";
	return {
		...(from ? { from } : {}),
		...(until ? { until } : {}),
		basis: "stated",
	};
}

export function createAgentOperations(deps: {
	conversation: ConversationService;
	continuity: ContinuityService;
	clock: () => string;
	id: () => string;
	/** Active (or, with `all`, every live-status) State items of the profile. */
	listState(db: Database, all: boolean): readonly StateItem[];
	/** The same write the API does; the immediate change it records carries `sourceRunId`. */
	remember(
		db: Database,
		input: Remember,
		sourceRunId: string | null,
		origin: "user_confirmed" | "agent_inferred",
	): { item: MemoryItemDto; changed: boolean };
	transition(
		db: Database,
		action: "stop",
		itemId: string,
		expectedRevision: number,
		sourceRunId: string | null,
	): MemoryItemDto;
}) {
	const { conversation, continuity, clock } = deps;

	function remember(
		db: Database,
		ctx: { conversationId: string; refs: AgentRefs; turns: AgentTurn[] },
		op: AgentOp,
	): AgentOpResult {
		const turn = turnOf(ctx, op.turn);
		if (!turn || turn.role !== "user") return rejected("invalid_input");
		const found = conversation.messageInTransaction(db, turn.messageId);
		if (
			!found ||
			found.message.conversationId !== ctx.conversationId ||
			found.message.role !== "user"
		)
			return rejected("invalid_input");
		// The evidence must be a literal part of what the user said.
		const quote = locateQuote(found.message.text, op.quote ?? "");
		if (quote === null) return rejected("quote_mismatch");
		// A scheduled prompt is stored as a user message but is not the user's word.
		if (isExcluded(db, turn.messageId)) return rejected("invalid_input");
		// Too short to evidence anything, or unrelated to the fact written from it.
		if (foldedLength(quote) < 2 || !sharesBigram(quote, op.text ?? ""))
			return rejected("quote_mismatch");
		let kind: Remember["kind"];
		let semanticKey: string;
		if (op.type === "update") {
			const ref = refOf(ctx, op.ref, "state");
			if (!ref) return rejected("unknown_ref");
			const item = deps
				.listState(db, false)
				.find((candidate) => candidate.itemId === ref.id);
			if (!item || item.status !== "active" || item.revision !== ref.revision)
				return rejected("item_changed");
			if (!isStateKind(item.kind)) return rejected("invalid_input");
			kind = item.kind;
			semanticKey = item.semanticKey;
		} else {
			if (!isStateKind(op.kind) || op.semanticKey === undefined)
				return rejected("invalid_input");
			kind = op.kind;
			semanticKey = op.semanticKey;
		}
		const requested = op.requested === true;
		if (!requested) {
			const refusal = inferenceRefusal(
				deps.listState(db, true),
				kind,
				semanticKey,
				op,
			);
			if (refusal) return refusal;
		}
		const validity = validityOf(op);
		if (validity === "invalid") return rejected("invalid_input");
		const stored = deps.remember(
			db,
			{
				conversationId: ctx.conversationId,
				messageId: turn.messageId,
				quote,
				kind,
				semanticKey,
				text: op.text ?? "",
				polarity: op.polarity ?? "affirmed",
				...(validity ? { validity } : {}),
			},
			turn.runId,
			// What the user did not ask for is the agent's own inference, whatever the quote says.
			requested ? "user_confirmed" : "agent_inferred",
		);
		// Who asked is recorded when the item was created or actually changed (a promotion included), never on a no-op.
		if (stored.changed)
			putProvenance(
				db,
				stored.item.id,
				turn.runId,
				requested ? "request" : "agent",
				clock(),
			);
		return applied;
	}

	function stop(
		db: Database,
		ctx: { refs: AgentRefs; turns: AgentTurn[] },
		op: AgentOp,
	): AgentOpResult {
		const turn = turnOf(ctx, op.turn);
		if (!turn || turn.role !== "user") return rejected("invalid_input");
		// Stopping is only ever the user's own request; the host trusts the model's reading of "requested".
		if (op.requested !== true) return rejected("invalid_input");
		const ref = refOf(ctx, op.ref, "state");
		if (!ref) return rejected("unknown_ref");
		try {
			deps.transition(db, "stop", ref.id, ref.revision, turn.runId);
		} catch (error) {
			if (error instanceof Error && error.message === "revision_conflict")
				return rejected("item_changed");
			throw error;
		}
		return applied;
	}

	function noteAdd(
		db: Database,
		ctx: { conversationId: string; turns: AgentTurn[] },
		op: AgentOp,
	): AgentOpResult {
		const turn = turnOf(ctx, op.turn);
		if (!turn || !isNoteKind(op.kind) || isExcluded(db, turn.messageId))
			return rejected("invalid_input");
		continuity.addByAgentInTransaction(db, ctx.conversationId, {
			kind: op.kind,
			text: op.text ?? "",
			sourceMessageId: turn.messageId,
		});
		return applied;
	}

	/** The evidence of a tendency: at least two distinct items that still count. */
	function evidenceOf(
		db: Database,
		ctx: { conversationId: string; refs: AgentRefs },
		labels: string[] | undefined,
	): TendencyEvidence[] | null {
		if (!labels || labels.length < 2) return null;
		const activeState = new Set(
			deps
				.listState(db, false)
				.filter((item) => item.status === "active")
				.map((item) => item.itemId),
		);
		const liveNotes = new Set(
			continuity
				.snapshotInTransaction(db, ctx.conversationId)
				.items.map((item) => item.id),
		);
		const evidence: TendencyEvidence[] = [];
		for (const label of labels) {
			const ref = ctx.refs[label];
			if (!ref) return null;
			if (ref.namespace === "state" && activeState.has(ref.id))
				evidence.push({ namespace: "state", id: ref.id });
			else if (ref.namespace === "continuity" && liveNotes.has(ref.id))
				evidence.push({ namespace: "continuity", id: ref.id });
			else return null;
		}
		return new Set(evidence.map((entry) => `${entry.namespace}:${entry.id}`))
			.size === evidence.length
			? evidence
			: null;
	}

	function dispatch(
		db: Database,
		ctx: { conversationId: string; refs: AgentRefs; turns: AgentTurn[] },
		op: AgentOp,
	): AgentOpResult {
		switch (op.type) {
			case "remember":
			case "update":
				return remember(db, ctx, op);
			case "stop":
				return stop(db, ctx, op);
			case "note_add":
				return noteAdd(db, ctx, op);
			case "note_update": {
				const ref = refOf(ctx, op.ref, "continuity");
				if (!ref) return rejected("unknown_ref");
				return continuity.updateByAgentInTransaction(db, ref.id, ref.revision, {
					text: op.text ?? "",
				})
					? applied
					: rejected("item_changed");
			}
			case "note_close": {
				const ref = refOf(ctx, op.ref, "continuity");
				if (!ref) return rejected("unknown_ref");
				if (op.status === undefined) return rejected("invalid_input");
				return continuity.closeByAgentInTransaction(
					db,
					ref.id,
					ref.revision,
					op.status,
				)
					? applied
					: rejected("item_changed");
			}
			case "tendency_add": {
				const text = op.text ?? "";
				if ([...text].length > MAX_TENDENCY_CHARS)
					return rejected("invalid_input");
				const evidence = evidenceOf(db, ctx, op.evidenceRefs);
				if (!evidence) return rejected("invalid_input");
				if (countActiveTendencies(db) >= MAX_ACTIVE_TENDENCIES)
					return rejected("limit_reached");
				const now = clock();
				insertTendency(db, {
					id: deps.id(),
					text,
					evidence,
					status: "active",
					revision: 1,
					createdAt: now,
					updatedAt: now,
				});
				return applied;
			}
			case "tendency_update": {
				const ref = refOf(ctx, op.ref, "tendency");
				if (!ref) return rejected("unknown_ref");
				const text = op.text ?? "";
				if ([...text].length > MAX_TENDENCY_CHARS)
					return rejected("invalid_input");
				const evidence = evidenceOf(db, ctx, op.evidenceRefs);
				if (!evidence) return rejected("invalid_input");
				const row = getTendency(db, ref.id);
				if (!row || row.status !== "active" || row.revision !== ref.revision)
					return rejected("item_changed");
				return updateTendency(
					db,
					ref.id,
					ref.revision,
					{ text, evidence },
					clock(),
				)
					? applied
					: rejected("item_changed");
			}
			case "tendency_retire": {
				const ref = refOf(ctx, op.ref, "tendency");
				if (!ref) return rejected("unknown_ref");
				return retireTendency(db, ref.id, ref.revision, clock())
					? applied
					: rejected("item_changed");
			}
			default:
				return rejected("invalid_input");
		}
	}

	return {
		/**
		 * One operation of the agent's output, all or nothing: a refusal (or an error) leaves no trace of it,
		 * and the operations before it stay. An unexpected error is a refusal too (`conflict`), logged without text.
		 */
		applyInTransaction(
			db: Database,
			ctx: { conversationId: string; refs: AgentRefs; turns: AgentTurn[] },
			op: AgentOp,
		): AgentOpResult {
			db.exec("SAVEPOINT memory_agent_op");
			let result: AgentOpResult;
			try {
				result = dispatch(db, ctx, op);
			} catch (error) {
				db.exec("ROLLBACK TO memory_agent_op");
				db.exec("RELEASE memory_agent_op");
				// An error nobody foresaw costs this operation, not the whole settle (which would stall the cursor).
				const reason = reasonOf(error);
				if (reason === null) {
					log.warn(
						"memory.agent_op_failed",
						{ reason: "unexpected_error" },
						error,
					);
					return rejected("conflict");
				}
				return rejected(reason);
			}
			if (result.status === "rejected") db.exec("ROLLBACK TO memory_agent_op");
			db.exec("RELEASE memory_agent_op");
			return result;
		},
	};
}
export type AgentOperations = ReturnType<typeof createAgentOperations>;
