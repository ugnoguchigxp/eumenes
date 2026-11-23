import { z } from "zod";
import type { Database } from "bun:sqlite";
import {
	listCandidates,
	type InferredCandidate,
	type StateItem,
} from "eumenes-memory/sqlite";
import { canonicalJson, sha256Hex } from "../../../infrastructure/digest";
import type {
	RememberExplicitInput,
	RememberExplicitOutcome,
} from "../contracts/immediate";
import type { CurationDeps } from "./curation-shared";

/** The conversations an evaluation runs in start with this (the evaluation runner refuses any other). */
export const EVAL_CONVERSATION_PREFIX = "eval-";
const prefixSchema = z
	.string()
	.max(120)
	.refine((value) => value.startsWith(EVAL_CONVERSATION_PREFIX));
const digestSchema = z.string().regex(/^[0-9a-f]{64}$/u);

/** Which records a prefix of conversation ids (the evaluation's `eval-`) left behind, and the digest of that list. */
export const residuePreviewInput = z.strictObject({
	conversationPrefix: prefixSchema,
});
export const residueApplyInput = z.strictObject({
	conversationPrefix: prefixSchema,
	digest: digestSchema,
});
/** Candidates (L1) that may move to State (L2), apart from the conversations of the prefix. */
export const candidatesPreviewInput = z.strictObject({
	excludeConversationPrefix: prefixSchema,
});
/**
 * `excludeConversationPrefix` is the preview's: the list the digest covers is rebuilt from it, so that a list that moved
 * since the preview is never applied.
 */
export const candidatesApplyInput = z.strictObject({
	excludeConversationPrefix: prefixSchema,
	candidateIds: z.array(z.string().min(1).max(240)).min(1).max(200),
	digest: digestSchema,
});

export type ResidueStateRow = {
	id: string;
	revision: number;
	kind: string;
	semanticKey: string;
	text: string;
	conversationIds: string[];
};
/** A record that stands on messages of the prefix and of other conversations: never stopped, only shown. */
export type ResidueMixedRow = {
	id: string;
	revision: number;
	kind: string;
	text: string;
	targetConversationIds: string[];
	otherConversationIds: string[];
	/** Evidence that is no readable message (a seed, a retracted message). */
	unresolvedEvidence: number;
};
export type ResiduePlanRow = {
	id: string;
	kind: string;
	state: string;
	revision: number;
	text: string;
	conversationId: string;
	reason: "evidence" | "stopped_memory";
};
/** An earlier version of the user's own, replaced by a stopped record, that comes back as a new active version. */
export type ResidueRestoreRow = {
	/** The superseded version that is written again. */
	id: string;
	/** The stopped record it had been replaced by. */
	replacedStoppedId: string;
	kind: string;
	text: string;
};
export type ResidueListing = {
	conversationPrefix: string;
	digest: string;
	states: ResidueStateRow[];
	mixed: ResidueMixedRow[];
	restores: ResidueRestoreRow[];
	candidates: {
		id: string;
		kind: string;
		semanticKey: string;
		text: string;
		conversationIds: string[];
	}[];
	plans: ResiduePlanRow[];
	tendencies: { id: string; revision: number; text: string }[];
};
/** What apply did, with the state each record was in before (the way back is in the report of the design). */
export type ResidueReceipt = {
	conversationPrefix: string;
	digest: string;
	/** Restore with `POST /api/memory/maintenance/apply` (`active: true`) and these references. */
	stoppedStates: {
		kind: "state";
		id: string;
		revision: number;
		previousRevision: number;
		previous: "active";
		text: string;
	}[];
	retiredTendencies: {
		kind: "tendency";
		id: string;
		revision: number;
		previousRevision: number;
		previous: "active";
		text: string;
	}[];
	/**
	 * Versions written again where the stop would have left a fact without a record (new ids). To undo: stop these first,
	 * then restore the stopped record.
	 */
	restoredStates: {
		id: string;
		revision: number;
		restoredFromId: string;
		replacedStoppedId: string;
		text: string;
	}[];
	/** No way back through the API: restore from the backup. */
	dismissedCandidates: { id: string; previous: "open" }[];
	closedPlans: {
		id: string;
		kind: string;
		revision: number;
		previous: string;
		text: string;
	}[];
};

export type TransferEvidence = {
	messageId: string;
	conversationId: string;
	createdAt: string;
	/** The whole message as said. */
	messageText: string;
	/** The part the candidate stands on; null when it cannot be cut out. */
	quote: string | null;
};
export type TransferRow = {
	candidateId: string;
	kind: string;
	semanticKey: string;
	text: string;
	polarity: "affirmed" | "negated";
	observationCount: number;
	evidence: TransferEvidence[];
};
export type TransferListing = {
	excludeConversationPrefix: string;
	digest: string;
	candidates: TransferRow[];
};
export type TransferReceipt = {
	moved: {
		candidateId: string;
		itemId: string;
		revision: number;
		status: "applied" | "unchanged";
	}[];
	skipped: { candidateId: string; reason: string }[];
};

export type MemoryResidueOptions = {
	/** Every State item of the profile, inactive ones too (the same read the owner's maintenance uses). */
	states: (db: Database) => readonly StateItem[];
	/** Operations of the immediate layer (`MemoryService` carries them). */
	immediate: {
		rememberExplicitInTransaction(
			db: Database,
			input: RememberExplicitInput,
		): RememberExplicitOutcome;
		/** The messages out of use (blocked or excluded). */
		withheldMessagesInTransaction(
			db: Database,
			messageIds: readonly string[],
		): ReadonlySet<string>;
	};
};

export const digestOf = (value: unknown) =>
	sha256Hex(
		canonicalJson(value, { omitUndefined: true, keyOrder: "codeUnit" }),
	);
export const byId = <T extends { id: string }>(rows: T[]) =>
	rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
export const sorted = (values: Iterable<string>) => [...new Set(values)].sort();

/** What both halves read: readiness, where evidence lies, and the open candidates. */
export function residueReads(deps: CurationDeps) {
	function ready() {
		if (!deps.ready()) throw new Error("memory_unavailable");
	}

	/** Where each piece of evidence lies: the conversation of a message, as the host holds it. */
	function resolver(db: Database) {
		const known = new Map<string, string | null>();
		const messageConversation = (
			messageId: string,
			recorded?: string,
		): string | null => {
			if (!known.has(messageId))
				known.set(
					messageId,
					deps.conversation.messageInTransaction(db, messageId)?.message
						.conversationId ?? null,
				);
			return known.get(messageId) ?? recorded ?? null;
		};
		const stateConversations = (item: StateItem): (string | null)[] =>
			item.evidence.length === 0
				? [null]
				: item.evidence.map((ref) =>
						ref.namespace === "conversation"
							? messageConversation(ref.id)
							: null,
					);
		const candidateConversations = (
			candidate: InferredCandidate,
		): (string | null)[] =>
			candidate.evidence.length === 0
				? [null]
				: candidate.evidence.map((ref) =>
						ref.namespace === "conversation"
							? messageConversation(ref.id)
							: null,
					);
		return {
			messageConversation,
			stateConversations,
			candidateConversations,
		};
	}

	function openCandidates(db: Database): InferredCandidate[] {
		const found: InferredCandidate[] = [];
		const { access, scopeKey } = deps.scoped(db, "memory.maintenance");
		let after: { updatedSeq: number; candidateId: string } | undefined;
		for (;;) {
			const listed = listCandidates(db, {
				contractVersion: 1,
				access,
				scopeKey,
				status: "open",
				limit: 200,
				...(after ? { after } : {}),
			});
			if (listed.status !== "ok") throw new Error("memory_blocked");
			found.push(...listed.candidates);
			if (!listed.nextCursor) break;
			after = listed.nextCursor;
		}
		return found;
	}

	return { ready, resolver, openCandidates };
}
