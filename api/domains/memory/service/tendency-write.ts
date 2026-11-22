import type { Database } from "bun:sqlite";
import { checkGroundedClaim } from "eumenes-memory";
import { PRINCIPAL, PROFILE_SCOPE } from "../contracts";
import type {
	WriteTendencyInput,
	WriteTendencyOutcome,
} from "../contracts/immediate";
import {
	countActiveTendencies,
	insertTendency,
	isBlocked,
	listActiveTendencies,
	type TendencyEvidence,
} from "../repository";
import { putTendencyRun } from "../repository/immediate";
import { hostMessageSource } from "./curation-shared";
import {
	MAX_ACTIVE_TENDENCIES,
	MAX_TENDENCY_CHARS,
} from "./curation-tendencies";
import { guarded, rejected, type ImmediateDeps } from "./immediate-shared";

/** The most messages one tendency may stand on (a candidate holds at most this many pieces of evidence). */
const MAX_TENDENCY_EVIDENCE = 256;
/** A tendency must stand on observations from at least this many conversations (the library's promotion rule). */
const MIN_CONVERSATIONS = 2;

const hasText = (value: unknown): value is string =>
	typeof value === "string" && value.trim() !== "";

/**
 * A tendency (L4) written by the sleeping layer (sections 4.1 and 6.2): grounded in the user's own messages from
 * several conversations and in the run that wrote it. It lives in `memory_tendency` with the steward's tendencies
 * (the same text and count limits) and is deleted with what it stands on: a forgotten message, or the candidate
 * it was promoted from (the forget's purge matches both).
 */
export function createTendencyWriter(deps: ImmediateDeps) {
	function write(
		db: Database,
		input: WriteTendencyInput,
	): WriteTendencyOutcome {
		if (!deps.ready()) return rejected("memory_unavailable");
		if (
			!hasText(input.sourceRunId) ||
			!hasText(input.text) ||
			[...input.text.trim()].length > MAX_TENDENCY_CHARS ||
			!Array.isArray(input.evidence) ||
			input.evidence.length === 0 ||
			input.evidence.length > MAX_TENDENCY_EVIDENCE ||
			(input.candidateId !== undefined && !hasText(input.candidateId))
		)
			return rejected("invalid_input");
		const text = input.text.trim();
		return guarded(db, (): WriteTendencyOutcome => {
			const messageIds = new Set<string>();
			const conversationIds = new Set<string>();
			for (const ref of input.evidence) {
				// Only the user's own messages: an outside note is not grounds for a tendency.
				if (
					ref.namespace !== "conversation" ||
					ref.kind !== "message" ||
					!hasText(ref.id)
				)
					return rejected("invalid_source");
				const found = deps.conversation.messageInTransaction(db, ref.id);
				if (!found || found.message.role !== "user")
					return rejected("invalid_source");
				if (isBlocked(db, ref.id)) return rejected("blocked_source");
				// The words it stood on must still be the words of the message.
				if (
					ref.digest !== undefined &&
					ref.digest !== hostMessageSource(found).digest
				)
					return rejected("invalid_source");
				messageIds.add(ref.id);
				conversationIds.add(found.message.conversationId);
			}
			const grounded = checkGroundedClaim(
				{
					promotion: {
						candidateId: input.candidateId ?? `run:${input.sourceRunId}`,
						evidenceCount: messageIds.size,
						conversationIds: [...conversationIds],
					},
					sourceRunId: input.sourceRunId,
				},
				{ requireRunId: true, minConversations: MIN_CONVERSATIONS },
				{ principal: PRINCIPAL, scopeKey: PROFILE_SCOPE },
			);
			if (!grounded.ok)
				return rejected(
					grounded.reasonCode === "NOT_ENOUGH_CONVERSATIONS"
						? "not_enough_conversations"
						: "invalid_input",
				);
			const same = listActiveTendencies(db).find(
				(tendency) => tendency.text === text,
			);
			if (same) return { status: "unchanged", tendencyId: same.id };
			if (countActiveTendencies(db) >= MAX_ACTIVE_TENDENCIES)
				return rejected("limit_reached");
			const evidence: TendencyEvidence[] = [
				...[...messageIds].map((id) => ({ namespace: "message" as const, id })),
				...(input.candidateId === undefined
					? []
					: [{ namespace: "candidate" as const, id: input.candidateId }]),
			];
			const now = deps.clock();
			const tendencyId = deps.id();
			insertTendency(db, {
				id: tendencyId,
				text,
				evidence,
				status: "active",
				revision: 1,
				createdAt: now,
				updatedAt: now,
			});
			putTendencyRun(db, tendencyId, input.sourceRunId);
			return {
				status: "written",
				tendencyId,
				revision: 1,
				conversationIds: [...conversationIds],
			};
		});
	}
	return { write };
}
