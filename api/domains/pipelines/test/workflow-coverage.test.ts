import { expect, test } from "bun:test";
import { workflowCheckpointCandidates } from "..";

const units = [
	{
		unitId: "one",
		evidenceRefs: ["this-run/one"],
		candidate: { from: "a", to: "b" },
	},
	{
		unitId: "two",
		evidenceRefs: ["this-run/two"],
		candidate: { from: "c", to: "d" },
	},
	{ unitId: "failed", evidenceRefs: [], candidate: null },
];
const processed = {
	unitId: "one",
	status: "processed",
	evidenceRefs: ["this-run/one"],
};
const skipped = (unitId: string) => ({
	unitId,
	status: "unprocessed",
	reason: "資料不足",
	evidenceRefs: [],
});
const complete = [processed, skipped("two"), skipped("failed")];

test("adopts only observed candidates covered by the journal", () => {
	expect(
		workflowCheckpointCandidates(units, complete, ["this-run/one"]),
	).toEqual([{ from: "a", to: "b" }]);
	expect(
		workflowCheckpointCandidates(
			units,
			units.map(({ unitId }) => skipped(unitId)),
			[],
		),
	).toEqual([]);
});

test("rejects missing, duplicate, fabricated and incorrectly covered units", () => {
	const verify = (coverage: unknown, evidence: string[] = []) =>
		workflowCheckpointCandidates(units, coverage, evidence);
	expect(() => verify(complete.slice(0, 2))).toThrow(
		"workflow_coverage_incomplete",
	);
	expect(() => verify([processed, processed, skipped("failed")])).toThrow(
		"workflow_coverage_unit_invalid",
	);
	expect(() =>
		verify([processed, skipped("unknown"), skipped("failed")]),
	).toThrow("workflow_coverage_unit_invalid");
	expect(() => verify(complete, ["previous-run/one"])).toThrow(
		"workflow_coverage_evidence_invalid",
	);
	expect(() =>
		verify([
			{ ...processed, evidenceRefs: ["this-run/two"] },
			...complete.slice(1),
		]),
	).toThrow("workflow_coverage_evidence_invalid");
	expect(() =>
		verify([
			...complete.slice(0, 2),
			{ ...processed, unitId: "failed", evidenceRefs: [] },
		]),
	).toThrow("workflow_coverage_processed_invalid");
});
