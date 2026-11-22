import type { Database } from "bun:sqlite";
import type { AccessContext } from "eumenes-memory";
import {
	listCandidates,
	listExclusions,
	type InferredCandidate,
} from "eumenes-memory/sqlite";
import { PROFILE_SCOPE } from "../contracts";

/** The identity of a fact: all its versions (and the candidates of it) share it. */
export const factKey = (item: {
	subject: string;
	kind: string;
	semanticKey: string;
}) => `${item.subject}\u0000${item.kind}\u0000${item.semanticKey}`;

/**
 * Every candidate (L1) of these facts, promoted into these items, or standing on one of these messages, whatever its status. A forget and its immediate
 * exclusion take them along: a candidate holds the same words the user asked to forget.
 */
export function candidatesOfFacts(
	db: Database,
	access: AccessContext,
	facts: ReadonlySet<string>,
	itemIds: ReadonlySet<string>,
	/** Messages being forgotten: a candidate that stands on one of them goes too (the library cannot cut one piece of evidence out). */
	messageIds: ReadonlySet<string> = new Set(),
): InferredCandidate[] {
	const found: InferredCandidate[] = [];
	for (const status of ["open", "dismissed", "promoted"] as const) {
		let after: { updatedSeq: number; candidateId: string } | undefined;
		for (;;) {
			const listed = listCandidates(db, {
				contractVersion: 1,
				access,
				scopeKey: PROFILE_SCOPE,
				status,
				...(after ? { after } : {}),
			});
			if (listed.status !== "ok") throw new Error("memory_blocked");
			for (const candidate of listed.candidates)
				if (
					facts.has(factKey(candidate)) ||
					(candidate.promotedItemId !== undefined &&
						itemIds.has(candidate.promotedItemId)) ||
					candidate.evidence.some(
						(ref) => ref.namespace === "conversation" && messageIds.has(ref.id),
					)
				)
					found.push(candidate);
			if (!listed.nextCursor) break;
			after = listed.nextCursor;
		}
	}
	return found;
}

/**
 * The candidates an immediate exclusion hid: a candidate that is excluded no longer shows in a listing, so the
 * closure delete that follows reads them from the exclusions (a forget in flight is what excluded them).
 */
export function excludedCandidateIds(
	db: Database,
	access: AccessContext,
): string[] {
	const listed = listExclusions(db, {
		contractVersion: 2,
		access,
		scopeKey: PROFILE_SCOPE,
	});
	if (listed.status !== "ok") throw new Error("memory_blocked");
	return listed.targets.flatMap((target) =>
		target.type === "candidate" ? [target.candidateId] : [],
	);
}
