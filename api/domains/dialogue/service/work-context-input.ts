import type { Database } from "bun:sqlite";
import type { ReferenceInput } from "../../memory";
import type { DialogueDeps } from "./context";

/** The exact source versions behind a work line, including the run that produced it. */
export function workContextInput(
	deps: DialogueDeps,
	db: Database,
	id: string,
): ReferenceInput | null {
	const row = deps.work?.workInTransaction(db, id);
	if (!row) return null;
	const inherited = deps.memory?.referenceInputs.readRunInTransaction(
		db,
		row.runId,
	);
	const direct = deps.memory?.referenceInputs.captureInTransaction(db, {
		messageIds: row.messageIds,
	}) ?? { sources: row.messageIds, complete: true };
	return {
		sources: [
			...new Set([
				...direct.sources,
				...(inherited?.sources ?? []),
				`host-work:${JSON.stringify([row.id, row.revision])}`,
			]),
		],
		complete: direct.complete && (inherited?.complete ?? false),
	};
}

/** Filter the work's body and dependency manifest together; its stored record is untouched. */
export function workContextCurrent(
	deps: DialogueDeps,
	db: Database,
	conversationId: string,
	id: string,
): boolean {
	if (!deps.agency?.isCurrentInputInTransaction) return true;
	const input = workContextInput(deps, db, id);
	return (
		!!input &&
		deps.agency.isCurrentInputInTransaction(db, input, conversationId)
	);
}
