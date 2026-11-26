import type { Database } from "bun:sqlite";
import {
	GOAL_ANALYSIS_MS,
	type GoalAttempt,
	type GoalObservation,
	type GoalPermit,
	type GoalProgress,
	type GoalStore,
} from "eumenes-agency/agenda/runtime";
import { hash } from "../../domains/capabilities";
import type {
	DevelopmentSupervisionService,
	GoalSupervisionReceipt,
	SupervisionHost,
	SupervisionMode,
	SupervisionTarget,
} from "../../domains/development-supervision";
import { goalExecutionSource } from "../agency/goal-execution-source";
import type {
	GoalCapability,
	GoalSurface,
} from "../agency/goal-progress-context";
import { goalAccess, goalDigest } from "../agency/goal-progress-context";
import type { GoalOwnerPort, GoalProgressPorts } from "../agency/goal-progress";
import {
	permitBaseline,
	READ_POLICY_BASELINE,
	type GoalWorkspaceRegistry,
} from "../agency/goal-workspaces";

const owner = "development-supervision";
const read = "development-supervision:read";
const edit = "development-supervision:edit";
const verifyPrefix = "development-supervision:check:";
const modes = (ref: string): SupervisionMode | null =>
	ref === edit
		? "edit"
		: ref === read
			? "read"
			: ref.startsWith(verifyPrefix)
				? "verify"
				: null;

function identity(row: GoalProgress, attempt: GoalAttempt) {
	return {
		principal: row.principal,
		scopeKey: row.ledgerScope,
		goalId: row.goalId,
		goalRevision: row.goalRevision,
		attemptId: attempt.id,
		permitId: attempt.permitId,
		permitRevision: attempt.permitRevision,
	};
}
function attemptObservation(
	attempt: GoalAttempt,
	receipt: GoalSupervisionReceipt,
): GoalObservation {
	const outcome =
		receipt.status === "completed"
			? "succeeded"
			: receipt.status === "partial"
				? "partial"
				: receipt.status === "failed" || receipt.status === "interrupted"
					? "failed"
					: receipt.status === "cancelled"
						? "cancelled"
						: "running";
	return {
		producer: owner,
		ref: attempt.dispatchId,
		version: String(receipt.ownerRevision),
		digest: goalDigest(receipt),
		evidence: receipt.evidence.map((item) => ({
			ref: item.ref,
			version: String(receipt.ownerRevision),
			digest: goalDigest(item),
			summary: item.text,
		})),
		attempt: {
			id: attempt.id,
			dispatchId: attempt.dispatchId,
			ownerWorkId: receipt.ownerWorkId,
			ownerRevision: receipt.ownerRevision,
			outcome,
			observed: receipt.result?.summary ?? receipt.question?.prompt ?? null,
			resultRef: outcome === "running" ? null : receipt.ownerWorkId,
			...(outcome === "running" && receipt.question
				? {
						question: {
							ref: receipt.question.id,
							prompt: receipt.question.prompt,
							expiresAtMs: receipt.question.expiresAt,
							released: receipt.questionReleased,
						},
					}
				: {}),
		},
	};
}
function supervisionScope(
	workspaces: GoalWorkspaceRegistry,
	row: GoalProgress,
	permit: GoalPermit,
	capability: string,
	now: number,
) {
	if (permit.scope.version !== 1) return null;
	const workspace = workspaces.get(permit.scope.workspaceRef);
	const mode = modes(capability);
	if (!workspace || workspace.root !== permit.workspace || !mode) return null;
	if (
		mode === "edit" &&
		(row.state.startedAt + GOAL_ANALYSIS_MS > now ||
			!permit.scope.writablePaths.length)
	)
		return null;
	const acceptanceRefs = new Set(
		workspace.checks
			.filter(({ acceptance }) => acceptance)
			.map(({ ref }) => ref),
	);
	const acceptance = permit.scope.checks.filter(({ ref }) =>
		acceptanceRefs.has(ref),
	);
	const checks =
		mode === "verify"
			? permit.scope.checks.filter(
					({ ref }) => ref === capability.slice(verifyPrefix.length),
				)
			: mode === "edit"
				? acceptance.length
					? acceptance
					: permit.scope.checks
				: [];
	if (mode !== "read" && !checks.length) return null;
	return {
		workspace: {
			workspaceRef: workspace.ref,
			targetRevision: permitBaseline(workspaces, {
				workspace: permit.workspace,
				scope: permit.scope,
			}),
			rootPath: workspace.root,
			checkExecutables: [
				...new Set(workspace.checks.map(({ command }) => command)),
			],
		},
		scope: {
			workspaceRef: workspace.ref,
			targetRevision: permitBaseline(workspaces, {
				workspace: permit.workspace,
				scope: permit.scope,
			}),
			mode,
			deadline: permit.scope.expiresAtMs ?? Number.MAX_SAFE_INTEGER,
			readablePaths: [
				...new Set([
					...permit.scope.readablePaths,
					...permit.scope.writablePaths,
				]),
			],
			writablePaths: mode === "edit" ? [...permit.scope.writablePaths] : [],
			checks: checks.map(({ command, args, cwd }) => ({
				executable: command,
				args: [...args],
				cwd,
			})),
		},
	};
}

export function createGoalSupervision(ports: {
	goals: GoalStore;
	supervision: DevelopmentSupervisionService;
	workspaces: GoalWorkspaceRegistry;
	binding: (db: Database) => SupervisionTarget | null;
	enabled: (db: Database) => boolean;
	sourcesCurrent: GoalProgressPorts["sourcesCurrent"];
	notify(db: Database, row: GoalProgress, observation: GoalObservation): void;
	now?: () => number;
}) {
	const { goals, supervision, workspaces } = ports;
	const now = ports.now ?? Date.now;
	const lookup = (db: Database, row: GoalProgress, attempt: GoalAttempt) =>
		goals.goalPermitInTransaction(db, goalAccess(row), row, attempt.permitId);
	const receiptFor = (
		attempt: GoalAttempt,
		receipt: GoalSupervisionReceipt,
	) => ({
		status: "known" as const,
		observation: attemptObservation(attempt, receipt),
	});
	const worker: GoalOwnerPort = {
		startInTransaction(db, row, attempt, permit) {
			const bound = ports.binding(db);
			if (!bound || bound.toolchainRevisionId !== permit.toolchainRevisionId)
				return { status: "refused", reason: "goal_binding_unavailable" };
			const source = goalExecutionSource(row, attempt, permit);
			return receiptFor(
				attempt,
				supervision.goal.startInTransaction(db, source, bound),
			);
		},
		lookupInTransaction(db, row, attempt) {
			const permit = lookup(db, row, attempt);
			if (!permit) return { status: "unknown" };
			const result = supervision.goal.lookupInTransaction(
				db,
				goalExecutionSource(row, attempt, permit),
			);
			return result ? receiptFor(attempt, result) : { status: "absent" };
		},
		cancelInTransaction(db, row, attempt) {
			const permit = lookup(db, row, attempt);
			if (!permit)
				return supervision.goal.cancelByIdentityInTransaction(
					db,
					{
						principal: row.principal,
						scopeKey: row.ledgerScope,
						goalId: row.goalId,
						goalRevision: row.goalRevision,
						attemptId: attempt.id,
						permitId: attempt.permitId,
						permitRevision: attempt.permitRevision,
					},
					attempt.dispatchId,
				);
			return supervision.goal.cancelInTransaction(
				db,
				goalExecutionSource(row, attempt, permit),
			);
		},
		answerInTransaction(db, row, attempt, permit, question) {
			supervision.goal.answerInTransaction(
				db,
				goalExecutionSource(row, attempt, permit),
				question,
			);
		},
		wake: () => supervision.flush(),
	};
	const authority: NonNullable<SupervisionHost["goal"]> = {
		authorityInTransaction(db, source) {
			const access = {
				principal: source.principal,
				scopeKeys: [source.scopeKey],
			};
			const row = goals.activeProgressInTransaction(db, access, source);
			const attempt =
				row &&
				goals.goalAttemptInTransaction(db, access, row, source.attemptId);
			const permit = row && attempt && lookup(db, row, attempt);
			const design = row?.state.design;
			const parked =
				!!row &&
				!!attempt &&
				row.currentWorkId !== attempt.id &&
				goals
					.parkedGoalAttemptsInTransaction(db, access, row)
					.some(({ id }) => id === attempt.id);
			if (
				!row ||
				!attempt ||
				!permit ||
				!ports.enabled(db) ||
				row.ledgerScope !== source.scopeKey ||
				(row.currentWorkId !== attempt.id && !parked) ||
				attempt.owner !== owner ||
				permit.revision !== attempt.permitRevision ||
				permit.revoked ||
				(permit.scope.expiresAtMs ?? Infinity) <= now() ||
				hash(goalExecutionSource(row, attempt, permit)) !== hash(source) ||
				ports.binding(db)?.bindingRevisionId !== source.bindingRevisionId ||
				(goals.goalScopeControlInTransaction(db, access, row.ledgerScope)
					?.allUntilMs ?? 0) > now()
			)
				return null;
			const inputs = [
				...(row.state.sourceRef ? [row.state.sourceRef] : []),
				...(permit.scope.basis.kind === "message"
					? permit.scope.basis.sourceRefs
					: []),
				...row.state.evidence
					.filter(({ ref }) => attempt.step.evidenceRefs.includes(ref))
					.flatMap(({ sources }) => sources ?? []),
			];
			if (!ports.sourcesCurrent(db, row, inputs)) return null;
			const scope = supervisionScope(
				workspaces,
				row,
				permit,
				attempt.operationRef ?? attempt.step.capabilityRef,
				now(),
			);
			if (
				permit.scope.version !== 1 ||
				!scope ||
				(scope.scope.mode === "edit" && !design) ||
				// A read-only policy works on the HEAD of its moment; any other permit stays on its commit.
				(permit.scope.baselineCommit !== READ_POLICY_BASELINE &&
					workspaces.revision(permit.workspace) !== permit.scope.baselineCommit)
			)
				return null;
			return {
				...scope,
				...(parked && { parked: true }),
				design: design
					? { documentId: design.id, digest: design.digest }
					: null,
			};
		},
		observeInTransaction(db, source, receipt) {
			if (!source.request && receipt.status === "interrupted") {
				goals.releaseForgottenGoalWorkInTransaction(
					db,
					source,
					source.attemptId,
					source.runId,
					source.permitId,
					source.permitRevision,
				);
				return;
			}
			const access = {
				principal: source.principal,
				scopeKeys: [source.scopeKey],
			};
			const row = goals.activeProgressInTransaction(db, access, source);
			const attempt =
				row &&
				goals.goalAttemptInTransaction(db, access, row, source.attemptId);
			if (
				row &&
				attempt &&
				attempt.dispatchId === source.runId &&
				authority.authorityInTransaction(db, source)
			)
				ports.notify(db, row, attemptObservation(attempt, receipt));
		},
	};
	function surface(
		db: Database,
		row: GoalProgress,
		permit: GoalPermit | null,
	): GoalSurface {
		const bound = ports.binding(db);
		const registration = permit && workspaces.get(permit.scope.workspaceRef);
		const watches =
			row.state.watch?.producer === "markdown" && row.state.watch.subjectRef
				? [row.state.watch]
				: [];
		if (!permit || permit.scope.version !== 1 || !registration || !bound)
			return { checks: [], capabilities: [], watches };
		const checks = registration.checks
			.filter(
				({ ref, acceptance }) =>
					acceptance && permit.scope.checks.some((item) => item.ref === ref),
			)
			.map(({ ref, description }) => ({
				ref,
				description,
				criterionIds: row.state.criteria.map(({ id }) => id),
			}));
		const verifyAfter = checks.length
			? permit.scope.writablePaths.length
				? [edit]
				: permit.scope.basis.kind === "policy"
					? [read]
					: []
			: [];
		if (!supervision.goalWorkerAvailableInTransaction(db, registration.ref))
			return { checks, capabilities: [], watches, verifyAfter };
		const capabilities: GoalCapability[] = [
			{
				ref: read,
				description: "開発監督に作業先の資料読取と現状の確認を依頼する。",
				allowedScope: JSON.stringify(permit.scope.readablePaths),
				effect: "read",
				owner,
				bindingRevisionId: bound.bindingRevisionId,
			},
		];
		for (const { ref, description, acceptance } of registration.checks) {
			const check = permit.scope.checks.find((item) => item.ref === ref);
			if (acceptance || !check) continue;
			capabilities.push({
				ref: verifyPrefix + ref,
				description:
					description + " この能力の選択で固定コマンドを新たに実行する。",
				effect: "read",
				owner,
				allowedScope: JSON.stringify({
					command: check.command,
					args: check.args,
					cwd: check.cwd,
					writablePaths: [],
				}),
				bindingRevisionId: bound.bindingRevisionId,
			});
		}
		if (permit.scope.writablePaths.length)
			capabilities.push({
				ref: edit,
				description: "開発監督に許可範囲内の変更を依頼する。",
				effect: "write",
				owner,
				allowedScope: JSON.stringify(permit.scope.writablePaths),
				bindingRevisionId: bound.bindingRevisionId,
			});

		return { capabilities, watches, checks, verifyAfter };
	}
	return {
		owners: { [owner]: worker },
		authority,
		surface,
		forgetInTransaction(db: Database, row: GoalProgress, attempt: GoalAttempt) {
			return (
				attempt.owner === owner &&
				supervision.goal.forgetInTransaction(
					db,
					identity(row, attempt),
					attempt.dispatchId,
				)
			);
		},
	};
}
