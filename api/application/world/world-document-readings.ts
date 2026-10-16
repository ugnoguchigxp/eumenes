import type { Database } from "bun:sqlite";
import type { WorldDocuments } from "../../domains/world";
import type { Source } from "../../domains/tool-runtime";
import { sha256Hex } from "../../infrastructure/digest";

/** Bounded original text for the existing evidence catalog. Search hits alone are not evidence. */
export function documentReadings(
	documents: WorldDocuments,
	db: Database,
	scope: { principal: string; scopeKey: string },
	raw: unknown,
	now: number,
) {
	const result = documents.lookupInTransaction(db, scope, raw);
	const observedAt = new Date(now).toISOString();
	const base = { observedAt, hits: [], documents: [], failures: [] };
	if (result.kind === "search") return { ...base, notes: result };
	const body = `収集資料: ${result.title}\n収集群: ${result.collection} / 版: ${result.revision}\n収集時の記録。外部の正本や現在の事実を再確認した結果ではない。\n${result.text}`;
	const reading: Source = {
		kind: "world_document",
		sourceId: crypto.randomUUID(),
		viewId: crypto.randomUUID(),
		sourceRef: result.id,
		sourceRevision: result.revision,
		scopeRef: scope.scopeKey,
		viewDigest: sha256Hex(body),
		title: result.title,
		basis: "world",
		origin: "collected_document",
		body,
		fetchedAt: observedAt,
		truncated: !result.complete,
		acquisitionTruncated: !result.complete,
	};
	return {
		...base,
		readings: [reading],
		notes: {
			documentId: result.id,
			offset: result.offset,
			end: result.end,
			nextOffset: result.nextOffset,
			completeness: result.complete ? "complete" : "partial",
		},
	};
}

export function documentsCurrent(
	documents: WorldDocuments,
	db: Database,
	scope: { principal: string; scopeKey: string },
	sources: readonly Omit<Source, "body">[],
) {
	return sources
		.filter((s) => s.kind === "world_document")
		.every(
			(s) =>
				s.scopeRef === scope.scopeKey &&
				!!s.sourceRef &&
				!!s.sourceRevision &&
				documents.isCurrentInTransaction(
					db,
					scope,
					s.sourceRef,
					s.sourceRevision,
				),
		);
}
