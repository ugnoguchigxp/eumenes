import type { Database } from "bun:sqlite";
import { assertUserState, type StateItem } from "eumenes-memory/sqlite";
import { inheritMarks, provenanceOf, putProvenance } from "../repository";
import { createEvidence } from "./curation-evidence";
import { MAX_EVIDENCE, type CurationDeps } from "./curation-shared";
import type { ResidueRestoreRow } from "./residue-shared";

const factOf = (item: StateItem) =>
	`${item.subject}\u0000${item.kind}\u0000${item.semanticKey}`;
/** The library's origin vocabulary for a version that is brought back. */
const restoredOrigin = (origin: StateItem["origin"]) =>
	origin === "user_confirmed" || origin === "user_edited"
		? origin
		: ("agent_inferred" as const);

/**
 * A correction made in an evaluation conversation replaced the user's own version, which the library keeps as
 * `superseded` and never reopens. Stopping the evaluation's version would leave the fact without a record, so the
 * version it replaced is brought back as a new version on its own evidence (as a withdrawal does).
 */
export function createResidueRestore(deps: CurationDeps) {
	const evidence = createEvidence(deps);
	return {
		/**
		 * For each record to stop: the newest superseded version of the same fact that rests on nothing of the prefix and
		 * still has usable evidence, when no other active version of the fact would remain.
		 */
		plan(
			db: Database,
			all: readonly StateItem[],
			stopped: ReadonlySet<string>,
			inPrefix: (item: StateItem) => boolean,
		): ResidueRestoreRow[] {
			const rows: ResidueRestoreRow[] = [];
			for (const item of all) {
				if (!stopped.has(item.itemId)) continue;
				const versions = all.filter(
					(other) =>
						other.itemId !== item.itemId && factOf(other) === factOf(item),
				);
				if (
					versions.some(
						(other) => other.status === "active" && !stopped.has(other.itemId),
					)
				)
					continue;
				const old = versions
					.filter(
						(other) =>
							other.status === "superseded" &&
							other.evidence.length > 0 &&
							!inPrefix(other) &&
							evidence.usableEvidence(db, other).length > 0,
					)
					.sort((a, b) => b.createdSeq - a.createdSeq)[0];
				if (old)
					rows.push({
						id: old.itemId,
						replacedStoppedId: item.itemId,
						kind: old.kind,
						text: old.value.text,
					});
			}
			return rows;
		},
		/** Writes the old version again as an active one (the stop of the fact's record comes first). */
		restore(
			db: Database,
			old: StateItem,
		): { id: string; revision: number } | null {
			const usable = evidence.usableEvidence(db, old).slice(0, MAX_EVIDENCE);
			if (usable.length === 0) return null;
			const runId = `residue:${deps.id()}`;
			const restored = assertUserState(db, {
				...deps.scoped(db, "memory.write"),
				clock: { atMs: deps.atMs() },
				kind: old.kind,
				subject: old.subject,
				semanticKey: old.semanticKey,
				value: old.value,
				evidence: usable.map((entry) => ({
					source: entry.evidence.source,
					quote: entry.evidence.quote,
				})),
				sources: usable.map((entry) => entry.host),
				origin: restoredOrigin(old.origin),
				...(old.validity
					? { validity: old.validity }
					: {
							...(old.validFromMs === null
								? {}
								: { validFromMs: old.validFromMs }),
							...(old.validUntilMs === null
								? {}
								: { validUntilMs: old.validUntilMs }),
						}),
				sourceRunId: runId,
			});
			if (restored.status !== "applied" && restored.status !== "unchanged")
				return null;
			inheritMarks(db, [old.itemId], restored.item.itemId);
			putProvenance(
				db,
				restored.item.itemId,
				runId,
				provenanceOf(db, old.itemId),
				deps.clock(),
				true,
			);
			return { id: restored.item.itemId, revision: restored.item.revision };
		},
	};
}
