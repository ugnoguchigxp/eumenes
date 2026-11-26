import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Database } from "bun:sqlite";
import type {
	GoalCheckAuthorization,
	GoalEvidence,
	GoalPermit,
	GoalProgress,
	GoalStore,
} from "eumenes-agency/agenda/runtime";
import { claudeInputDigest, createCheckSandbox } from "../../domains/coding";
import {
	currentGoalPermits,
	goalAccess,
	goalDigest,
} from "./goal-progress-context";
import type { GoalProgressPorts } from "./goal-progress";
import {
	READ_POLICY_BASELINE,
	type GoalWorkspaceRegistry,
} from "./goal-workspaces";

const execute = promisify(execFile);
const proofPrefix = "goal-verification:";
const inputDigest = (permit: GoalPermit) =>
	claudeInputDigest([
		...new Set([...permit.scope.readablePaths, ...permit.scope.writablePaths]),
	]);
function matches(stdout: string, expected: unknown) {
	if (expected === undefined) return true;
	try {
		return goalDigest(JSON.parse(stdout)) === goalDigest(expected);
	} catch {
		return false;
	}
}

export async function runGoalCheck(
	workspace: string,
	check: GoalCheckAuthorization,
	signal: AbortSignal,
	options?: Parameters<typeof createCheckSandbox>[2] & { timeoutMs?: number },
) {
	let sandbox: ReturnType<typeof createCheckSandbox>;
	try {
		sandbox = createCheckSandbox(workspace, crypto.randomUUID(), options);
	} catch {
		return {
			exitCode: null,
			stdout: "",
			stderr: "goal_verification_sandbox_unavailable",
		};
	}
	try {
		const command = sandbox.command({
			executable: check.command,
			args: [...check.args],
			cwd: check.cwd,
		});
		try {
			const output = await execute("/bin/sh", ["-c", command], {
				signal,
				timeout: options?.timeoutMs ?? 30_000,
				maxBuffer: 128 * 1024,
				env: { PATH: "/usr/bin:/bin" },
			});
			return {
				exitCode: 0,
				stdout: output.stdout.slice(0, options ? 24_576 : 4_096),
				stderr: output.stderr.slice(0, options ? 24_576 : 4_096),
			};
		} catch (error) {
			signal.throwIfAborted();
			const failed = error as {
				code?: unknown;
				stdout?: string;
				stderr?: string;
			};
			return {
				exitCode: typeof failed.code === "number" ? failed.code : null,
				stdout: failed.stdout?.slice(0, options ? 24_576 : 4_096) ?? "",
				stderr: failed.stderr?.slice(0, options ? 24_576 : 4_096) ?? "",
			};
		}
	} finally {
		sandbox.cleanup();
	}
}

type MachineCheck = {
	ref: string;
	description: string;
	criterionIds: string[];
	permit: GoalPermit;
	check: GoalCheckAuthorization;
	expectedJson?: unknown;
};

export function createGoalVerification(ports: {
	goals: GoalStore;
	workspaces: GoalWorkspaceRegistry;
	sourcesCurrent: GoalProgressPorts["sourcesCurrent"];
	now?: () => number;
}) {
	const now = ports.now ?? Date.now;
	function available(db: Database, row: GoalProgress): MachineCheck[] {
		const permits = currentGoalPermits(db, { ...ports, nowMs: now() }, row);
		const attempts = ports.goals.goalAttemptsInTransaction(
			db,
			goalAccess(row),
			row,
		);
		return permits.flatMap((permit) => {
			if (permit.scope.version !== 1) return [];
			const { workspaceRef } = permit.scope;
			const workspace = ports.workspaces.get(workspaceRef);
			if (
				!workspace ||
				workspace.root !== permit.workspace ||
				// A read-only policy checks the HEAD of its moment; any other permit stays on its commit.
				(permit.scope.baselineCommit !== READ_POLICY_BASELINE &&
					ports.workspaces.revision(workspace.root) !==
						permit.scope.baselineCommit)
			)
				return [];
			const criterionIds = row.state.criteria
				.filter(
					({ id }) =>
						permit.scope.basis.kind === "message" ||
						// The goal read this workspace under this permit and kept evidence for the criterion: whether
						// the worker then concluded or not, the registered check of what it read may run.
						attempts.some(
							(attempt) =>
								attempt.permitId === permit.id &&
								attempt.permitRevision === permit.revision &&
								(attempt.outcome === "succeeded" ||
									attempt.outcome === "partial" ||
									attempt.outcome === "failed") &&
								attempt.evidenceRefs.length &&
								attempt.step.criterionIds.some(
									(target) => id === target || id.startsWith(target + "."),
								),
						),
				)
				.map(({ id }) => id);
			if (!criterionIds.length) return [];
			return workspace.checks.flatMap((registration) => {
				const check = permit.scope.checks.find(
					({ ref }) => ref === registration.ref,
				);
				if (
					!registration.acceptance ||
					!check ||
					(permit.scope.basis.kind === "policy" &&
						!workspace.policyCheckRefs.includes(registration.ref)) ||
					goalDigest(check) !==
						goalDigest(ports.workspaces.check(workspaceRef, registration.ref))
				)
					return [];
				const ref = `goal-check:${goalDigest([permit.id, permit.revision, check])}`;
				return [
					{
						ref,
						description: `作業先 ${workspaceRef}。${registration.description}`,
						criterionIds,
						permit,
						check,
						...(registration.expectedJson !== undefined && {
							expectedJson: registration.expectedJson,
						}),
					},
				];
			});
		});
	}
	const checks = (db: Database, row: GoalProgress) =>
		available(db, row).map(({ ref, description, criterionIds, permit }) => ({
			ref,
			description,
			criterionIds,
			permitId: permit.id,
		}));
	function match(
		db: Database,
		row: GoalProgress,
		ref: string,
		criterionId: string,
	) {
		const candidates = available(db, row).filter((item) =>
			item.criterionIds.includes(criterionId),
		);
		const exact = candidates.find((item) => item.ref === ref);
		if (exact) return exact;
		const legacy = candidates.filter(
			(item) =>
				item.check.ref === ref && item.permit.scope.basis.kind === "message",
		);
		return legacy.length === 1 ? legacy[0] : undefined;
	}
	const verify: NonNullable<GoalProgressPorts["verify"]> = (db, row) => {
		const step = row.state.next;
		if (step?.kind !== "verify") return null;
		const selected = step.checks.map((entry) => ({
			...entry,
			candidate: match(db, row, entry.checkRef, entry.criterionId),
		}));
		if (selected.some(({ candidate }) => !candidate)) return null;
		return async (signal) => {
			const results = new Map<
				string,
				{
					before: string;
					observed: Awaited<ReturnType<typeof runGoalCheck>>;
					stable: boolean;
				}
			>();
			for (const { checkRef, candidate } of selected) {
				if (results.has(checkRef)) continue;
				const { permit, check } = candidate!;
				const before = inputDigest(permit);
				if (!before) throw new Error("goal_verification_input_unavailable");
				const observed = await runGoalCheck(permit.workspace, check, signal);
				results.set(checkRef, {
					before,
					observed,
					stable: before === inputDigest(permit),
				});
			}
			return selected.map(
				({ criterionId, checkRef, evidenceRefs, candidate }) => {
					const { permit, expectedJson } = candidate!;
					const { before, observed, stable } = results.get(checkRef)!;
					const passed =
						stable &&
						observed.exitCode === 0 &&
						matches(observed.stdout, expectedJson);
					const sources =
						permit.scope.basis.kind === "message"
							? permit.scope.basis.sourceRefs
							: undefined;
					return {
						checkRef,
						criterionId,
						passed,
						evidence: {
							ref:
								proofPrefix +
								goalDigest([
									row.goalId,
									row.goalRevision,
									criterionId,
									checkRef,
								]),
							version: before,
							digest: goalDigest([before, checkRef, observed]),
							summary: JSON.stringify({
								checkRef,
								criterionId,
								permitId: permit.id,
								permitRevision: permit.revision,
								...observed,
								stable,
								passed,
								evidenceRefs,
							}),
							...(sources && { sources }),
						},
					};
				},
			);
		};
	};
	function evidenceCurrent(
		db: Database,
		row: GoalProgress,
		evidence: GoalEvidence,
	) {
		if (
			!evidence.ref.startsWith(proofPrefix) ||
			!ports.sourcesCurrent(db, row, evidence.sources ?? [])
		)
			return false;
		try {
			const receipt = JSON.parse(evidence.summary) as {
				checkRef: string;
				criterionId?: string;
				permitId?: string;
				permitRevision?: number;
			};
			const candidate = receipt.criterionId
				? match(db, row, receipt.checkRef, receipt.criterionId)
				: undefined;
			if (receipt.permitId)
				return (
					!!candidate &&
					candidate.permit.id === receipt.permitId &&
					candidate.permit.revision === receipt.permitRevision &&
					inputDigest(candidate.permit) === evidence.version
				);
			const legacy = available(db, row).filter(
				({ check, permit }) =>
					check.ref === receipt.checkRef &&
					permit.scope.basis.kind === "message",
			);
			return (
				legacy.length === 1 &&
				inputDigest(legacy[0]!.permit) === evidence.version
			);
		} catch {
			return false;
		}
	}
	function staleVerificationEvidence(db: Database, row: GoalProgress) {
		return new Set(
			row.state.criteria
				.filter(({ status }) => status === "passed")
				.flatMap(({ evidenceRefs }) => evidenceRefs)
				.filter(
					(ref) =>
						!row.state.evidence.some(
							(evidence) =>
								evidence.ref === ref && evidenceCurrent(db, row, evidence),
						),
				),
		);
	}
	return {
		checks,
		verify,
		evidenceCurrent,
		staleVerificationEvidence,
		verificationCurrent: (
			db: Database,
			row: GoalProgress,
			results: readonly { evidence: GoalEvidence }[],
		) =>
			results.every(({ evidence }) => evidenceCurrent(db, row, evidence)) &&
			!staleVerificationEvidence(db, row).size,
	};
}
