import type { Database } from "bun:sqlite";
import type { MemoryService } from "../../domains/memory";
import {
	recordPrefix,
	staleRecordInputs,
	type AgencyRecordInputDeps,
} from "./input";

export function captureGoalSources(
	db: Database,
	referenceInputs: MemoryService["referenceInputs"],
	sources: readonly string[],
	records?: AgencyRecordInputDeps,
) {
	const recordStamps = sources.filter((id) => id.startsWith(recordPrefix));
	if (
		recordStamps.length &&
		(!records || staleRecordInputs(records, db, recordStamps).length)
	)
		return { complete: false, sources: [] };
	const stamped = sources.filter((id) => id.startsWith("memory-input:"));
	const itemIds = sources
		.filter((id) => id.startsWith("memory:"))
		.map((id) => id.slice("memory:".length));
	const messageIds = sources.filter(
		(id) =>
			!id.startsWith("memory-input:") &&
			!id.startsWith("memory:") &&
			!id.startsWith(recordPrefix),
	);
	if (
		!referenceInputs.isCurrentInTransaction(db, {
			complete: true,
			sources: stamped,
		})
	)
		return { complete: false, sources: [] };
	const captured = referenceInputs.captureInTransaction(db, {
		messageIds,
		itemIds,
	});
	return {
		complete: captured.complete,
		sources: [...new Set([...captured.sources, ...stamped, ...recordStamps])],
	};
}
