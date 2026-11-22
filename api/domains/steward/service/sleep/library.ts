import type { Database } from "bun:sqlite";
import type { AccessContext } from "eumenes-memory";
import {
	listCandidates,
	listExclusions,
	type MemoryDb,
} from "eumenes-memory/sqlite";
import type {
	EvidenceReader,
	JudgeLlm,
	MemoryStore,
} from "eumenes-consolidation";
import { sha256Hex } from "../../../../infrastructure/digest";
import { PRINCIPAL, PROFILE_SCOPE } from "../../../memory/contracts";
import { INFERENCE_MS, type ChatMessage } from "../../contracts";
import type { StewardDeps } from "../types";

/** The structured request cap of a sleep judgement (inference allows up to 2400 for a structured answer). */
const SLEEP_MAX_OUTPUT_TOKENS = 2000;
/** A sleep run's calls are named after the job and the order they are made in. */
const TASK_ID = "steward";

/** The access the library checks, with the policy revision as it stands in this transaction. */
export function libraryAccess(db: Database, deps: StewardDeps): AccessContext {
	return {
		principal: PRINCIPAL,
		scopeKeys: [PROFILE_SCOPE],
		purpose: "memory.consolidation",
		policyRevision: deps.memory.policyRevisionInTransaction(db),
	};
}
export const LIBRARY_SCOPE = PROFILE_SCOPE;

/**
 * Open candidates (L1) the shallow consolidation has not read yet: their `updatedSeq` is above the watermark.
 * Counts at most `limit` (the caller only asks whether the threshold is reached).
 */
export function newCandidateCount(
	db: Database,
	deps: StewardDeps,
	watermark: number,
	limit: number,
): number {
	let count = 0;
	let after: { updatedSeq: number; candidateId: string } | undefined;
	for (;;) {
		const page = listCandidates(db, {
			contractVersion: 1,
			access: libraryAccess(db, deps),
			scopeKey: PROFILE_SCOPE,
			limit: 200,
			...(after ? { after } : {}),
		});
		if (page.status !== "ok") return count;
		// Newest first: the first one at or below the watermark ends the new ones.
		for (const candidate of page.candidates) {
			if (candidate.updatedSeq <= watermark) return count;
			if (++count >= limit) return count;
		}
		if (!page.nextCursor) return count;
		after = page.nextCursor;
	}
}

/**
 * The library's store: the steward's single writer, one transaction for each operation. `fence` runs first in every
 * write transaction, in the same transaction as the writes: it throws when the ground the run stood on has moved,
 * and then nothing of that write happens.
 */
export function memoryStore(
	deps: StewardDeps,
	fence?: (db: Database) => void,
): MemoryStore {
	return {
		read: async <T>(operation: (db: MemoryDb) => T) =>
			deps.store.read((db) => operation(db)),
		write: <T>(operation: (db: MemoryDb) => T) =>
			deps.store.write((db) => {
				fence?.(db);
				return operation(db);
			}),
	};
}

/**
 * The state items the library holds as excluded (a forget excluded them at once and its closure delete has not
 * removed them yet).
 */
export function excludedTargets(
	db: Database,
	deps: StewardDeps,
): { itemIds: string[] } {
	const listed = listExclusions(db, {
		contractVersion: 2,
		access: libraryAccess(db, deps),
		scopeKey: PROFILE_SCOPE,
	});
	if (listed.status !== "ok") return { itemIds: [] };
	return {
		itemIds: listed.targets.flatMap((target) =>
			target.type === "state_item" ? [target.itemId] : [],
		),
	};
}

/**
 * The words a candidate stands on: the user's message the reference names, as it reads now. A message that is
 * gone, blocked (forgotten) or no longer available is not readable. A note of the agent's research is not
 * readable here (no host operation hands its text back yet), so a candidate that stands on one only loses that evidence.
 */
export function evidenceReader(deps: StewardDeps): EvidenceReader {
	return {
		read(db, ref) {
			if (ref.namespace !== "conversation" || ref.kind !== "message")
				return null;
			const found = deps.conversation.messageInTransaction(
				db as Database,
				ref.id,
			);
			if (!found) return null;
			if (
				deps.memory.blockedMessageIdsInTransaction(db as Database, [ref.id])
					.size > 0
			)
				return null;
			if (
				deps.conversation.sourceInTransaction(db as Database, ref.id).state !==
				"available"
			)
				return null;
			const digest = sha256Hex(found.message.text);
			return {
				conversationId: found.message.conversationId,
				source: {
					namespace: "conversation",
					kind: "message",
					id: found.message.id,
					representation: "text",
					revision: `sha256:${digest}`,
					digest,
					principal: PRINCIPAL,
					scopeKey: PROFILE_SCOPE,
					status: "available",
					content: found.message.text,
					ordinal: found.ordinal,
				},
			};
		},
	};
}

/**
 * The library's model calls on the steward's own inference path: each call takes a background request, runs on a
 * connection of its own that yields to the user's calls (a yield ends the call with `larm_preempted`), and is
 * accepted when its answer arrives. The model and the route are the ones the saved settings give; nothing is named here.
 */
export function judgeLlm(
	deps: StewardDeps,
	run: { jobId: string; attempt: number; generation: number },
): JudgeLlm & { lastError(): unknown } {
	const { inference, store } = deps;
	let calls = 0;
	let last: unknown;
	return {
		lastError: () => last,
		async complete(request, signal) {
			const decisionId = `${run.jobId}.${run.attempt}.${++calls}`;
			const deadline = deps.nowMs() + INFERENCE_MS;
			const requestId = await store.write((db) =>
				inference.captureBackgroundControlInTransaction(db, {
					taskId: TASK_ID,
					decisionId,
					authorityEpoch: 1,
					executionGeneration: run.generation,
					deadline,
					taskDeadline: deadline,
					maxOutputTokens: Math.min(
						request.maxOutputTokens ?? SLEEP_MAX_OUTPUT_TOKENS,
						SLEEP_MAX_OUTPUT_TOKENS,
					),
					route: "conversation",
					structuredOutput: true,
				}),
			);
			const messages: ChatMessage[] = [{ role: "user", content: request.user }];
			try {
				const receipt = await inference.executeControl(
					requestId,
					messages,
					AbortSignal.any([
						...(signal ? [signal] : []),
						AbortSignal.timeout(INFERENCE_MS),
					]),
					{ instructions: request.system, outputSchema: request.outputSchema },
					{ sessionRole: "auxiliary", yields: true },
				);
				const accepted = await store.write((db) =>
					inference.acceptInTransaction(db, receipt),
				);
				if (!accepted) throw new Error("not_accepted");
				return {
					text:
						typeof receipt.value === "string"
							? receipt.value
							: new TextDecoder().decode(receipt.value),
				};
			} catch (error) {
				last = error;
				await store.write((db) =>
					inference.cancelRequestsInTransaction(db, [requestId]),
				);
				inference.flushCancelledRequests([requestId]);
				throw error;
			}
		},
	};
}
