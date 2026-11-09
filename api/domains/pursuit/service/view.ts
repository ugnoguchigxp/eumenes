import type { Database } from "bun:sqlite";
import { loadPursuit } from "eumenes-pursuit/sqlite";
import type { ExecutionResult, ExecutionView } from "../../tool-runtime";
import { documents, rowOf, stateOf, type RunRow } from "../repository";

export function viewInTransaction(
	db: Database,
	id: string,
): ExecutionView | null {
	const row = rowOf(db, id);
	if (!row?.data_json) return null;
	const state = stateOf(row),
		core = row.core_id ? loadPursuit(db, row.core_id) : null;
	const question =
		row.state === "waiting_user"
			? core?.consultations.find((q) => q.answer === null)
			: null;
	return {
		id,
		conversationId: row.conversation_id,
		request: state.request,
		revision: row.revision,
		status: row.state,
		deadline: row.deadline,
		question: question
			? {
					id: question.id,
					prompt: question.question,
					expiresAt: row.deadline,
					inputSchema: {
						type: "object",
						properties: {
							answer: { type: "string", minLength: 1, maxLength: 8000 },
						},
						required: ["answer"],
						additionalProperties: false,
					},
				}
			: null,
		result: state.result,
	};
}
export function finalResult(
	db: Database,
	row: RunRow,
	code?: string,
): ExecutionResult {
	const state = stateOf(row),
		draft = state.draft,
		core = row.core_id ? loadPursuit(db, row.core_id) : null;
	const cited = new Set(draft?.claims.flatMap((c) => c.evidence) ?? []);
	return {
		status: row.state,
		summary: draft?.summary ?? "調査を完了できませんでした。",
		fulfilled:
			core?.report?.criteria.filter((c) => c.passed).map((c) => c.evidence) ??
			[],
		missing: [
			...(draft?.limitations ?? []),
			...(core?.report?.criteria
				.filter((c) => !c.passed)
				.map((c) => c.evidence) ?? []),
		],
		refs: [...cited],
		...(code ? { code } : {}),
		answer: draft?.answer,
		claims: draft?.claims.map((c) => ({
			text: c.text,
			status: c.status,
			sourceIds: c.evidence,
		})),
		sources: documents(db, row)
			.filter((d) => cited.has(d.id))
			.map((d) => ({
				sourceId: d.id,
				url: d.url,
				title: d.title,
				fetchedAt: d.fetched_at,
			})),
		limitations: draft?.limitations,
		assurance: "model",
		stopReason: draft?.stopReason ?? core?.report?.reason ?? code,
	};
}
