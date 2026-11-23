import type { z } from "zod";
import type { Database } from "bun:sqlite";
import { sliceUtf8Range } from "eumenes-memory";
import { dismissCandidate } from "eumenes-memory/sqlite";
import type { RememberExplicitInput } from "../contracts/immediate";
import { isStateKind, type CurationDeps } from "./curation-shared";

import {
	digestOf,
	residueReads,
	type candidatesApplyInput,
	type MemoryResidueOptions,
	type TransferEvidence,
	type TransferListing,
	type TransferReceipt,
	type TransferRow,
} from "./residue-shared";

/** Candidates (L1) that may move into State (L2): the list to choose from, and the move itself. */
export function createCandidateTransfer(
	deps: CurationDeps,
	options: MemoryResidueOptions,
) {
	const { ready, openCandidates } = residueReads(deps);
	function transferListing(db: Database, prefix: string): TransferListing {
		ready();
		const candidates: TransferRow[] = [];
		const open = openCandidates(db).filter(
			(candidate) =>
				candidate.subject === "self" &&
				isStateKind(candidate.kind) &&
				candidate.evidence.length > 0 &&
				candidate.evidence.every((ref) => ref.namespace === "conversation"),
		);
		const withheld = options.immediate.withheldMessagesInTransaction(
			db,
			open.flatMap((candidate) => candidate.evidence.map((ref) => ref.id)),
		);
		for (const candidate of open) {
			const evidence: TransferEvidence[] = [];
			for (const ref of candidate.evidence) {
				const found = deps.conversation.messageInTransaction(db, ref.id);
				// A retracted, forgotten or excluded message, the assistant's words, or an evaluation's message: not a ground.
				if (
					!found ||
					found.message.role !== "user" ||
					found.message.conversationId.startsWith(prefix) ||
					withheld.has(ref.id)
				)
					break;
				const slice = ref.range
					? sliceUtf8Range(found.message.text, ref.range)
					: undefined;
				evidence.push({
					messageId: ref.id,
					conversationId: found.message.conversationId,
					createdAt: found.message.createdAt,
					messageText: found.message.text,
					quote: slice?.status === "ok" ? slice.text : null,
				});
			}
			if (evidence.length !== candidate.evidence.length) continue;
			candidates.push({
				candidateId: candidate.candidateId,
				kind: candidate.kind,
				semanticKey: candidate.semanticKey,
				text: candidate.value.text,
				polarity: candidate.value.polarity,
				observationCount: candidate.observationCount,
				evidence,
			});
		}
		candidates.sort((a, b) =>
			a.candidateId < b.candidateId
				? -1
				: a.candidateId > b.candidateId
					? 1
					: 0,
		);
		const body = { excludeConversationPrefix: prefix, candidates };
		return { ...body, digest: digestOf(body) };
	}

	/** One candidate into State as the user's confirmed record, and the candidate closed; a refusal leaves no trace. */
	function moveCandidate(
		db: Database,
		row: TransferRow,
	): TransferReceipt["moved"][number] | { reason: string } {
		db.exec("SAVEPOINT memory_residue_move");
		let result: TransferReceipt["moved"][number] | { reason: string } = {
			reason: "no_usable_quote",
		};
		try {
			for (const evidence of row.evidence) {
				if (evidence.quote === null) continue;
				const outcome = options.immediate.rememberExplicitInTransaction(db, {
					conversationId: evidence.conversationId,
					sourceRunId: `residue:${deps.id()}`,
					messageId: evidence.messageId,
					quote: evidence.quote,
					subject: "self",
					kind: row.kind as RememberExplicitInput["kind"],
					semanticKey: row.semanticKey,
					text: row.text,
					polarity: row.polarity,
					requested: false,
				});
				if (outcome.status === "rejected") {
					result = { reason: outcome.reason };
					// Another piece of evidence may carry a quote the message still holds.
					if (
						outcome.reason === "quote_mismatch" ||
						outcome.reason === "invalid_source"
					)
						continue;
					break;
				}
				const closed = dismissCandidate(db, {
					...deps.scoped(db, "memory.write"),
					clock: { atMs: deps.atMs() },
					candidateId: row.candidateId,
				});
				result =
					closed.status === "applied" || closed.status === "unchanged"
						? {
								candidateId: row.candidateId,
								itemId: outcome.itemId,
								revision: outcome.revision,
								status: outcome.status,
							}
						: {
								reason: `dismiss_${closed.status === "rejected" ? closed.reasonCode : closed.status}`,
							};
				break;
			}
		} catch (error) {
			db.exec("ROLLBACK TO memory_residue_move");
			db.exec("RELEASE memory_residue_move");
			throw error;
		}
		if ("reason" in result) db.exec("ROLLBACK TO memory_residue_move");
		db.exec("RELEASE memory_residue_move");
		return result;
	}

	function applyTransfer(
		db: Database,
		input: z.infer<typeof candidatesApplyInput>,
	): TransferReceipt {
		const listing = transferListing(db, input.excludeConversationPrefix);
		if (listing.digest !== input.digest)
			throw new Error("maintenance_conflict");
		const rows = new Map(
			listing.candidates.map((row) => [row.candidateId, row]),
		);
		const receipt: TransferReceipt = { moved: [], skipped: [] };
		for (const candidateId of new Set(input.candidateIds)) {
			const row = rows.get(candidateId);
			if (!row) {
				receipt.skipped.push({ candidateId, reason: "not_listed" });
				continue;
			}
			const moved = moveCandidate(db, row);
			if ("reason" in moved)
				receipt.skipped.push({ candidateId, reason: moved.reason });
			else receipt.moved.push(moved);
		}
		return receipt;
	}

	return { transferListing, applyTransfer };
}
