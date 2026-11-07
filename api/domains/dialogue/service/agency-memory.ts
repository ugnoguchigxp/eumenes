import type { Database } from "bun:sqlite";
import { LIMITS_EXTERNAL } from "eumenes-memory";
import type { MemoryService } from "../../memory";
import {
	agencyObservations,
	agencyDependents,
	replaceAgencyDependents,
} from "../repository/agency-observations";

/** Replacing a checkpoint's dependency registration is part of its writer transaction. */
export function refreshAgencyDependencies(
	db: Database,
	memory: Pick<MemoryService, "referenceInputs"> | undefined,
	conversationId: string,
	scope: string,
	refs: readonly string[],
) {
	if (!memory) return;
	const port = memory.referenceInputs;
	const old = agencyDependents(db, conversationId);
	if (old.length)
		port.unregisterInTransaction(
			db,
			old.map((externalId) => ({ providerRef: "agency", externalId })),
		);
	const dependencies = [
		...agencyObservations(db, conversationId)
			.filter((row) => row.scope === scope)
			.map((row) => ({
				type: "source" as const,
				id: JSON.stringify([
					row.ref.namespace,
					row.ref.kind,
					row.ref.id,
					row.ref.representation ?? null,
				]),
			})),
		...refs
			.filter((ref) => ref.startsWith("memory:"))
			.map((ref) => ({
				type: "state_item" as const,
				id: ref.slice("memory:".length),
			})),
	];
	const ids: string[] = [];
	for (
		let i = 0;
		i < dependencies.length;
		i += LIMITS_EXTERNAL.maxDependenciesPerDependent
	) {
		const externalId = crypto.randomUUID();
		port.registerInTransaction(db, [
			{
				providerRef: "agency",
				externalId,
				dependsOn: dependencies.slice(
					i,
					i + LIMITS_EXTERNAL.maxDependenciesPerDependent,
				),
			},
		]);
		ids.push(externalId);
	}
	replaceAgencyDependents(db, conversationId, ids);
}
