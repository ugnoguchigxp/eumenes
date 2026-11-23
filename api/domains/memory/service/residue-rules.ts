import type { Database } from "bun:sqlite";
import { readCandidate } from "eumenes-memory/sqlite";
import { listStoredTendencies } from "../repository/tendency";
import type { CurationDeps } from "./curation-shared";
import { createResidueRestore } from "./residue-restore";

import {
	byId,
	digestOf,
	residueReads,
	sorted,
	type MemoryResidueOptions,
	type ResidueListing,
	type ResidueMixedRow,
	type ResiduePlanRow,
	type ResidueStateRow,
} from "./residue-shared";

/** The records of the prefix's conversations that cleaning would stop or close, with the digest of that list. */
export function createResidueListing(
	deps: CurationDeps,
	options: MemoryResidueOptions,
) {
	const { ready, resolver, openCandidates } = residueReads(deps);
	const restoring = createResidueRestore(deps);
	function residueListing(db: Database, prefix: string): ResidueListing {
		ready();
		const where = resolver(db);
		const inTarget = (conversationId: string | null) =>
			conversationId !== null && conversationId.startsWith(prefix);
		const all = options.states(db);
		const states: ResidueStateRow[] = [];
		const mixed: ResidueMixedRow[] = [];
		for (const item of all) {
			if (item.subject !== "self" || item.status !== "active") continue;
			const places = where.stateConversations(item);
			const inside = places.filter(inTarget);
			if (inside.length === 0) continue;
			if (inside.length === places.length)
				states.push({
					id: item.itemId,
					revision: item.revision,
					kind: item.kind,
					semanticKey: item.semanticKey,
					text: item.value.text,
					conversationIds: sorted(inside as string[]),
				});
			else
				mixed.push({
					id: item.itemId,
					revision: item.revision,
					kind: item.kind,
					text: item.value.text,
					targetConversationIds: sorted(inside as string[]),
					otherConversationIds: sorted(
						places.filter(
							(place): place is string => place !== null && !inTarget(place),
						),
					),
					unresolvedEvidence: places.filter((place) => place === null).length,
				});
		}
		const stopped = new Set(states.map((row) => row.id));
		const restores = restoring.plan(db, all, stopped, (item) =>
			where.stateConversations(item).some(inTarget),
		);

		const candidates = openCandidates(db).flatMap((candidate) => {
			const places = where.candidateConversations(candidate);
			if (!places.every(inTarget)) return [];
			return [
				{
					id: candidate.candidateId,
					kind: candidate.kind,
					semanticKey: candidate.semanticKey,
					text: candidate.value.text,
					conversationIds: sorted(places as string[]),
				},
			];
		});

		const plans: ResiduePlanRow[] = deps.continuity.plans
			.listInTransaction(db, {
				kinds: ["plan", "intent", "open_question"],
			})
			.flatMap((plan): ResiduePlanRow[] => {
				const places = plan.evidence.map((entry) =>
					where.messageConversation(entry.messageId, entry.conversationId),
				);
				const messagesInside = places.every(inTarget);
				const reason =
					places.length > 0 && messagesInside
						? "evidence"
						: plan.memoryItemIds.length > 0 &&
							  messagesInside &&
							  plan.memoryItemIds.every((id) => stopped.has(id))
							? "stopped_memory"
							: null;
				return reason === null
					? []
					: [
							{
								id: plan.id,
								kind: plan.kind,
								state: plan.state,
								revision: plan.revision,
								text: plan.text,
								conversationId: plan.conversationId,
								reason,
							},
						];
			});

		const stateById = new Map(all.map((item) => [item.itemId, item]));
		const tendencies = listStoredTendencies(db)
			.filter((tendency) => tendency.status === "active")
			.flatMap((tendency) => {
				const places = tendency.evidence.flatMap((entry): (string | null)[] => {
					switch (entry.namespace) {
						case "message":
							return [where.messageConversation(entry.id)];
						case "state": {
							const item = stateById.get(entry.id);
							return item ? where.stateConversations(item) : [null];
						}
						case "candidate": {
							const read = readCandidate(db, {
								...deps.scoped(db, "memory.maintenance"),
								candidateId: entry.id,
							});
							return read.status === "ok"
								? where.candidateConversations(read.candidate)
								: [null];
						}
						case "continuity": {
							const plan = deps.continuity.plans.getInTransaction(db, entry.id);
							return plan && plan.evidence.length > 0
								? plan.evidence.map((e) =>
										where.messageConversation(e.messageId, e.conversationId),
									)
								: [null];
						}
					}
				});
				return places.length > 0 && places.every(inTarget)
					? [
							{
								id: tendency.id,
								revision: tendency.revision,
								text: tendency.text,
							},
						]
					: [];
			});

		const body = {
			conversationPrefix: prefix,
			states: byId(states),
			mixed: byId(mixed),
			restores: byId(restores),
			candidates: byId(candidates),
			plans: byId(plans),
			tendencies: byId(tendencies),
		};
		return { ...body, digest: digestOf(body) };
	}

	return residueListing;
}
