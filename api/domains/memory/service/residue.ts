import type { z } from "zod";
import type { Database } from "bun:sqlite";
import { deactivateState, dismissCandidate } from "eumenes-memory/sqlite";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import { bumpForgetSeq, getTendency, retireTendency } from "../repository";
import type { CurationDeps } from "./curation-shared";
import { createResidueRestore } from "./residue-restore";

import { createCandidateTransfer } from "./residue-candidates";
import { createResidueListing } from "./residue-rules";
import {
	candidatesApplyInput,
	candidatesPreviewInput,
	residueApplyInput,
	residuePreviewInput,
	type MemoryResidueOptions,
	type ResidueListing,
	type ResidueReceipt,
	type TransferListing,
	type TransferReceipt,
} from "./residue-shared";

export * from "./residue-shared";

/**
 * Cleaning up what an evaluation left in the production memory, and moving candidates (L1) into State (L2) (design
 * section 6). Both are previewed first; an apply whose digest differs from the list as it stands changes nothing and
 * throws `maintenance_conflict`. State, tendencies, candidates and plans are saved in one writer transaction. Messages,
 * runs and the steward's records are never touched.
 */
export function createMemoryResidue(
	store: SqliteStore,
	deps: CurationDeps,
	options: MemoryResidueOptions,
) {
	const residueListing = createResidueListing(deps, options);
	const restoring = createResidueRestore(deps);
	const { transferListing, applyTransfer } = createCandidateTransfer(
		deps,
		options,
	);

	function applyResidue(
		db: Database,
		input: z.infer<typeof residueApplyInput>,
	): ResidueReceipt {
		const listing = residueListing(db, input.conversationPrefix);
		if (listing.digest !== input.digest)
			throw new Error("maintenance_conflict");
		const receipt: ResidueReceipt = {
			conversationPrefix: listing.conversationPrefix,
			digest: listing.digest,
			stoppedStates: [],
			restoredStates: [],
			retiredTendencies: [],
			dismissedCandidates: [],
			closedPlans: [],
		};
		for (const row of listing.states) {
			const result = deactivateState(db, {
				...deps.scoped(db, "memory.write"),
				clock: { atMs: deps.atMs() },
				itemId: row.id,
				expectedRevision: row.revision,
			});
			if (result.status !== "applied") throw new Error("maintenance_conflict");
			receipt.stoppedStates.push({
				kind: "state",
				id: row.id,
				revision: result.item.revision,
				previousRevision: row.revision,
				previous: "active",
				text: row.text,
			});
		}
		// A fact the stop left without a record gets its earlier version of the user's own back.
		const before = options.states(db);
		for (const row of listing.restores) {
			const old = before.find((item) => item.itemId === row.id);
			const restored = old && restoring.restore(db, old);
			if (!restored) throw new Error("maintenance_conflict");
			receipt.restoredStates.push({
				id: restored.id,
				revision: restored.revision,
				restoredFromId: row.id,
				replacedStoppedId: row.replacedStoppedId,
				text: row.text,
			});
		}
		for (const row of listing.tendencies) {
			if (!retireTendency(db, row.id, row.revision, deps.clock()))
				throw new Error("maintenance_conflict");
			receipt.retiredTendencies.push({
				kind: "tendency",
				id: row.id,
				revision: getTendency(db, row.id)?.revision ?? row.revision + 1,
				previousRevision: row.revision,
				previous: "active",
				text: row.text,
			});
		}
		for (const row of listing.candidates) {
			const result = dismissCandidate(db, {
				...deps.scoped(db, "memory.write"),
				clock: { atMs: deps.atMs() },
				candidateId: row.id,
			});
			if (result.status !== "applied") throw new Error("maintenance_conflict");
			receipt.dismissedCandidates.push({ id: row.id, previous: "open" });
		}
		for (const row of listing.plans) {
			const plan = deps.continuity.plans.getInTransaction(db, row.id);
			if (!plan) throw new Error("maintenance_conflict");
			// Closing needs evidence: the plan's own words (or its memory) stand for it.
			const first = plan.evidence[0];
			const closed = deps.continuity.plans.closeInTransaction(db, row.id, {
				expectedRevision: row.revision,
				evidence: first
					? {
							messages: [
								{
									messageId: first.messageId,
									conversationId: first.conversationId,
									quote: first.quote,
								},
							],
						}
					: { messages: [], memoryItemIds: plan.memoryItemIds },
			});
			if (!closed) throw new Error("maintenance_conflict");
			receipt.closedPlans.push({
				id: row.id,
				kind: row.kind,
				revision: closed.revision,
				previous: row.state,
				text: row.text,
			});
		}
		if (
			receipt.stoppedStates.length > 0 ||
			receipt.retiredTendencies.length > 0
		) {
			// The revocation fence of the owner's maintenance: answers prepared before it must not use the old state.
			bumpForgetSeq(db);
			deps.windows.recordImmediateInTransaction(db, "state_stop", null);
			// Stored windows carry the stopped texts: the next input builds them again.
			deps.windows.purgeInTransaction(db);
		}
		return receipt;
	}

	return {
		/** Read-only: the records of the prefix's conversations that apply would stop or close, and the digest of that list. */
		previewResidue: (raw: unknown): ResidueListing => {
			const input = residuePreviewInput.parse(raw);
			return store.read((db) => residueListing(db, input.conversationPrefix));
		},
		applyResidue: (raw: unknown): Promise<ResidueReceipt> => {
			const input = residueApplyInput.parse(raw);
			return store.write((db) => applyResidue(db, input));
		},
		/** Read-only: the candidates that may move to State, with the words they stand on. */
		previewCandidates: (raw: unknown): TransferListing => {
			const input = candidatesPreviewInput.parse(raw);
			return store.read((db) =>
				transferListing(db, input.excludeConversationPrefix),
			);
		},
		applyCandidates: (raw: unknown): Promise<TransferReceipt> => {
			const input = candidatesApplyInput.parse(raw);
			return store.write((db) => applyTransfer(db, input));
		},
	};
}
export type MemoryResidue = ReturnType<typeof createMemoryResidue>;
