import type { Database } from "bun:sqlite";
import type { GoalEvidence, GoalProgress } from "eumenes-agency/agenda/runtime";
import type { createGoalVerification } from "./goal-verification";
import {
	goalDocumentCheckRef,
	type createGoalSemanticVerification,
} from "./goal-semantic-verification";
import type { GoalProgressPorts } from "./goal-progress";

export function composeGoalVerifiers(
	machine: ReturnType<typeof createGoalVerification>,
	semantic: ReturnType<typeof createGoalSemanticVerification>,
) {
	function current(db: Database, row: GoalProgress, evidence: GoalEvidence) {
		return (
			machine.evidenceCurrent(db, row, evidence) ||
			semantic.evidenceCurrent(db, row, evidence)
		);
	}
	function staleVerificationEvidence(db: Database, row: GoalProgress) {
		return new Set(
			row.state.criteria
				.filter(({ status }) => status === "passed")
				.flatMap(({ evidenceRefs }) => evidenceRefs)
				.filter(
					(ref) =>
						!row.state.evidence.some(
							(evidence) => evidence.ref === ref && current(db, row, evidence),
						),
				),
		);
	}
	const verify: NonNullable<GoalProgressPorts["verify"]> = (db, row) => {
		const step = row.state.next;
		if (step?.kind !== "verify") return null;
		const documentChecks = step.checks.filter(
			({ checkRef }) => checkRef === goalDocumentCheckRef,
		);
		const machineChecks = step.checks.filter(
			({ checkRef }) => checkRef !== goalDocumentCheckRef,
		);
		const selected = (checks: typeof step.checks): GoalProgress => ({
			...row,
			state: { ...row.state, next: { ...step, checks } },
		});
		const runDocuments = documentChecks.length
			? semantic.verify(db, selected(documentChecks))
			: null;
		const runMachine = machineChecks.length
			? machine.verify(db, selected(machineChecks))
			: null;
		if (
			(documentChecks.length && !runDocuments) ||
			(machineChecks.length && !runMachine)
		)
			return null;
		return async (signal) => [
			...(runMachine ? await runMachine(signal) : []),
			...(runDocuments ? await runDocuments(signal) : []),
		];
	};
	return {
		checks: (db: Database, row: GoalProgress) => [
			...machine.checks(db, row),
			...semantic.checks(db, row),
		],
		verify,
		staleVerificationEvidence,
		verificationCurrent: (
			db: Database,
			row: GoalProgress,
			checks: readonly { evidence: GoalEvidence }[],
		) =>
			checks.every(({ evidence }) => current(db, row, evidence)) &&
			!staleVerificationEvidence(db, row).size,
	};
}
