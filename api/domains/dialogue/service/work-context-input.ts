import type { Database } from "bun:sqlite";
import type { ReferenceInput } from "../../memory";
import { workById } from "../repository/work";
import type { DialogueDeps } from "./context";

/** The exact source versions behind a work line, including the run that produced it. */
export function workContextInput(
	deps: DialogueDeps,
	db: Database,
	id: string,
	purpose?: "image-observation",
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
	let sources = inherited?.sources ?? [];
	if (purpose === "image-observation") {
		// A completed TODO's old status can be part of the originating conversation's State.
		// The pixel observation uses the accepted image. Retain the dependency on the other
		// TODO's availability so withdrawal or result removal still invalidates it.
		sources = sources.map((ref) => {
			if (!ref.startsWith("host-work:")) return ref;
			const [workId, revision] = JSON.parse(ref.slice("host-work:".length)) as [
				string,
				number,
			];
			const work = workById(db, workId);
			if (
				workId === row.id ||
				!work?.archivedAt ||
				work.conversationId !== row.conversationId ||
				work.revision <= revision ||
				!work.request ||
				work.result === null
			)
				return ref;
			return `host-work:${JSON.stringify([work.id, work.revision])}`;
		});
	}
	return {
		sources: [
			...new Set([
				...direct.sources,
				...sources,
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
	purpose?: "image-observation",
): boolean {
	if (!deps.agency?.isCurrentInputInTransaction) return true;
	const input = workContextInput(deps, db, id, purpose);
	return (
		!!input &&
		deps.agency.isCurrentInputInTransaction(db, input, conversationId)
	);
}
