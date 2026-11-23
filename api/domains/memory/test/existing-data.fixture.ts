import { recordCandidate } from "eumenes-memory/sqlite";
import { PRINCIPAL, PROFILE_SCOPE } from "../contracts";
import { insertTendency, type TendencyEvidence } from "../repository";
import {
	byteLength,
	hostMessageSource,
	refOf,
} from "../service/curation-shared";
import type { MemoryHarness } from "./memory.fixture";

/**
 * Data of the removed sleeping layer, as an existing database still holds it: the candidates (L1) and tendencies
 * (L4) the forget removes. The memory no longer writes either, so a test plants them with the library directly.
 */

/** A candidate standing on the whole text of each user message given (its place of observation is the first one's conversation). */
export async function plantCandidate(
	h: MemoryHarness,
	input: {
		messageIds: readonly string[];
		kind: "preference" | "personal_fact" | "constraint" | "habit";
		semanticKey: string;
		text: string;
	},
): Promise<{ candidateId: string }> {
	return h.store.write((db) => {
		const found = input.messageIds.map((id) => {
			const message = h.conversation.messageInTransaction(db, id);
			if (!message) throw new Error(`no message ${id}`);
			return message;
		});
		const sources = found.map(hostMessageSource);
		const result = recordCandidate(db, {
			contractVersion: 1,
			access: {
				principal: PRINCIPAL,
				scopeKeys: [PROFILE_SCOPE],
				purpose: "memory.write",
				policyRevision: h.memory.policyRevisionInTransaction(db),
			},
			scopeKey: PROFILE_SCOPE,
			clock: { atMs: Date.parse(h.time.now) },
			kind: input.kind,
			subject: "self",
			semanticKey: input.semanticKey,
			value: { text: input.text, polarity: "affirmed" },
			evidence: sources.map((source, i) => ({
				source: refOf(source, {
					startByte: 0,
					endByte: byteLength(found[i]!.message.text),
				}),
				quote: found[i]!.message.text,
			})),
			sources,
			conversationId: found[0]!.message.conversationId,
			sourceRunId: "run-planted",
		});
		if (result.status !== "recorded")
			throw new Error(`candidate not recorded: ${JSON.stringify(result)}`);
		return { candidateId: result.candidate.candidateId };
	});
}

/** An active tendency standing on messages (and on a candidate), with the run row the sleeping layer wrote. */
export function plantTendency(
	h: MemoryHarness,
	input: {
		text: string;
		messageIds: readonly string[];
		candidateId?: string;
	},
): Promise<string> {
	return h.store.write((db) => {
		const id = `tendency-${input.text}`;
		const evidence: TendencyEvidence[] = [
			...input.messageIds.map((messageId) => ({
				namespace: "message" as const,
				id: messageId,
			})),
			...(input.candidateId === undefined
				? []
				: [{ namespace: "candidate" as const, id: input.candidateId }]),
		];
		insertTendency(db, {
			id,
			text: input.text,
			evidence,
			status: "active",
			revision: 1,
			createdAt: h.time.now,
			updatedAt: h.time.now,
		});
		db.query(
			"INSERT INTO memory_tendency_run (tendency_id, run_id) VALUES (?,?)",
		).run(id, "run-planted");
		return id;
	});
}
