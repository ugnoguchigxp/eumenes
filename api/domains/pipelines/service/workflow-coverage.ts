import { z } from "zod";

const ref = z.string().min(1).max(300);
const entry = {
	unitId: ref,
	evidenceRefs: z.array(ref).max(256),
};
const coverageEntry = z.discriminatedUnion("status", [
	z.strictObject({
		...entry,
		status: z.literal("processed"),
		reason: z.string().max(2000).optional(),
	}),
	z.strictObject({
		...entry,
		status: z.literal("unprocessed"),
		reason: z.string().trim().min(1).max(2000),
	}),
]);
export const workflowCoverage = z.array(coverageEntry);

type ObservedUnit<Checkpoint> = {
	unitId: string;
	evidenceRefs: readonly string[];
	candidate: Checkpoint | null;
};

/** Match coverage to host-issued units frozen for this run, without interpreting the body. */
export function workflowCheckpointCandidates<Checkpoint>(
	units: readonly ObservedUnit<Checkpoint>[],
	rawCoverage: unknown,
	bodyEvidenceRefs: readonly string[],
) {
	const coverage = workflowCoverage.max(units.length).parse(rawCoverage);
	const pending = new Map(units.map((unit) => [unit.unitId, unit]));
	if (pending.size !== units.length)
		throw new Error("workflow_observation_duplicate");
	const allowedEvidence = new Set(units.flatMap((unit) => unit.evidenceRefs));
	if (bodyEvidenceRefs.some((value) => !allowedEvidence.has(value)))
		throw new Error("workflow_coverage_evidence_invalid");
	const candidates: Checkpoint[] = [];
	for (const item of coverage) {
		const unit = pending.get(item.unitId);
		if (!unit) throw new Error("workflow_coverage_unit_invalid");
		pending.delete(item.unitId);
		const evidence = new Set(unit.evidenceRefs);
		if (item.evidenceRefs.some((value) => !evidence.has(value)))
			throw new Error("workflow_coverage_evidence_invalid");
		if (item.status === "processed") {
			if (unit.candidate === null || item.evidenceRefs.length === 0)
				throw new Error("workflow_coverage_processed_invalid");
			candidates.push(unit.candidate);
		}
	}
	if (pending.size !== 0) throw new Error("workflow_coverage_incomplete");
	return candidates;
}
