import type { Database } from "bun:sqlite";
import { deactivateState } from "eumenes-memory/sqlite";
import type { HostSourceState, StateItem } from "eumenes-memory/sqlite";
import type { CurationItem, CurationResult } from "../contracts";
import { putProvenance } from "../repository";
import {
	MAX_EVIDENCE,
	MAX_TEXT_CHARS,
	applied,
	isStateKind,
	rejected,
	type CurationDeps,
	type Evidence,
} from "./curation-shared";
import type { EvidenceBuilder } from "./curation-evidence";
import type { StateWriter } from "./curation-state";
import { normalizeKey } from "./quote";

/** Several State items become one: the union of their evidence, minus what may no longer be used. */
export function createMerge(
	deps: CurationDeps,
	evidence: EvidenceBuilder,
	writer: StateWriter,
) {
	const { windows, clock } = deps;
	const { usableEvidence } = evidence;
	const { items, writeState, activeAt } = writer;

	function merge(
		db: Database,
		item: Extract<CurationItem, { op: "merge" }>,
	): CurationResult {
		const unique = new Map(item.sources.map((s) => [s.itemId, s.revision]));
		if (unique.size < 2 || unique.size > 8)
			return rejected("merge", "invalid_input");
		const text = item.text.trim();
		if (text === "" || [...text].length > MAX_TEXT_CHARS)
			return rejected("merge", "invalid_input");
		const sources: StateItem[] = [];
		for (const [itemId, revision] of unique) {
			const target = activeAt(db, itemId, revision);
			if ("reason" in target) return rejected("merge", target.reason);
			sources.push(target.item);
		}
		const kind = sources[0]?.kind;
		if (
			!kind ||
			!isStateKind(kind) ||
			sources.some((source) => source.kind !== kind)
		)
			return rejected("merge", "invalid_input");
		const newest = [...sources].sort((a, b) => b.updatedSeq - a.updatedSeq)[0];
		let key: string | null;
		if (item.key === undefined || item.key === null || item.key === "")
			key = newest?.semanticKey ?? null;
		else key = normalizeKey(item.key);
		if (key === null) return rejected("merge", "invalid_key");
		// The union of what the sources stand on, minus what may no longer be used.
		const collected = new Map<
			string,
			{ evidence: Evidence; host: HostSourceState }
		>();
		for (const source of sources)
			for (const entry of usableEvidence(db, source))
				collected.set(
					`${entry.evidence.source.id}|${entry.evidence.source.range.startByte}|${entry.evidence.source.range.endByte}`,
					entry,
				);
		if (collected.size === 0) return rejected("merge", "no_evidence");
		const kept = [...collected.values()]
			.sort((a, b) => b.host.ordinal - a.host.ordinal)
			.slice(0, MAX_EVIDENCE);
		const hosts = new Map(kept.map((entry) => [entry.host.id, entry.host]));
		const confirmed = sources.some(
			(source) =>
				source.origin === "user_confirmed" || source.origin === "user_edited",
		);
		const written = writeState(db, {
			kind,
			semanticKey: key,
			text,
			negated: item.negated === true,
			evidence: kept.map((entry) => entry.evidence),
			sources: [...hosts.values()],
			origin: confirmed ? "user_confirmed" : "agent_inferred",
			validity: null,
			force: true,
		});
		if (!written.ok) return rejected("merge", written.reason);
		putProvenance(db, written.item.itemId, null, "agent", clock(), null);
		// The merged item is stored; the sources it did not replace are stopped, in the same transaction.
		const stoppedIds: string[] = [];
		for (const source of sources) {
			const current = items(db, true).find(
				(candidate) => candidate.itemId === source.itemId,
			);
			if (!current || current.status !== "active") continue;
			const stopped = deactivateState(db, {
				...deps.scoped(db, "memory.write"),
				clock: { atMs: deps.atMs() },
				itemId: current.itemId,
				expectedRevision: current.revision,
			});
			if (stopped.status !== "applied") return rejected("merge", "conflict");
			stoppedIds.push(current.itemId);
		}
		windows.recordImmediateInTransaction(db, "state_replace", null);
		return applied("merge", {
			id: written.item.itemId,
			revision: written.item.revision,
			changed: true,
			stoppedIds,
		});
	}

	return { merge };
}
