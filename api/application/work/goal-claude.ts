import type { Database } from "bun:sqlite";
import { realpathSync } from "node:fs";
import type {
	GoalAttempt,
	GoalObservation,
	GoalPermit,
	GoalProgress,
	GoalReadPolicyGrant,
	GoalStore,
} from "eumenes-agency/agenda/runtime";
import type { Capabilities } from "../../domains/capabilities";
import {
	adapterRef,
	type ClaudeCodeService,
	type GoalTaskView,
} from "../../domains/claude-code";
import { codingCanonicalJSON } from "../../domains/coding";
import type { GoalExecutionSource } from "../../domains/tool-runtime";
import { goalExecutionSource } from "../agency/goal-execution-source";
import { goalDigest, type GoalSurface } from "../agency/goal-progress-context";
import type { GoalOwnerPort, GoalProgressPorts } from "../agency/goal-progress";
import { ordinaryClaudeWorkspaceRef } from "./claude-code-task-adapter";

export const ordinaryGoalOwner = "claude-code";
const read = "claude-code:read";
const edit = "claude-code:edit";
const operations = { [read]: "analysis", [edit]: "work" } as const;
type Binding = { toolchainRevisionId: string; bindingRevisionId: string };

function bindingFor(db: Database, capabilities: Capabilities): Binding | null {
	const active = capabilities
		.toolchainsInTransaction(db)
		.find(({ id }) => id === "claude-code.request");
	if (!active) return null;
	const binding = capabilities.toolchainBindingInTransaction(
		db,
		active.revisionId,
	)?.binding;
	return binding?.document.adapterRef === adapterRef &&
		binding.document.execution === "task"
		? {
				toolchainRevisionId: active.revisionId,
				bindingRevisionId: binding.revisionId,
			}
		: null;
}

const operation = (attempt: GoalAttempt) =>
	operations[
		(attempt.operationRef ??
			attempt.step.capabilityRef) as keyof typeof operations
	];

const identity = (row: GoalProgress, attempt: GoalAttempt) => ({
	principal: row.principal,
	scopeKey: row.ledgerScope,
	goalId: row.goalId,
	goalRevision: row.goalRevision,
	attemptId: attempt.id,
	permitId: attempt.permitId,
	permitRevision: attempt.permitRevision,
	runId: attempt.dispatchId,
});

function receipt(
	row: GoalProgress,
	attempt: GoalAttempt,
	work: GoalTaskView,
): { status: "known"; observation: GoalObservation } {
	const finished = [
		"completed",
		"partial",
		"failed",
		"cancelled",
		"interrupted",
	].includes(work.status);
	const outcome = !finished
		? "running"
		: work.status === "completed"
			? "succeeded"
			: work.status === "cancelled"
				? "cancelled"
				: work.status === "partial"
					? "partial"
					: "failed";
	const summary = [
		work.result?.summary ?? work.progress?.summary,
		...(work.result?.fulfilled ?? []),
		...(work.result?.missing ?? []),
	]
		.filter(Boolean)
		.join("\n")
		.slice(0, 3_000);
	const version = String(work.revision);
	const observation: GoalObservation = {
		producer: ordinaryGoalOwner,
		ref: attempt.dispatchId,
		version,
		digest: goalDigest([
			work.status,
			work.result,
			work.question,
			work.released,
			work.revision,
		]),
		evidence:
			finished && work.hasObservation
				? [
						{
							ref: "goal-claude:" + work.id,
							version,
							digest: goalDigest([work.id, version, summary]),
							summary,
							sources: row.state.sourceRef ? [row.state.sourceRef] : [],
						},
					]
				: [],
		attempt: {
			id: attempt.id,
			dispatchId: attempt.dispatchId,
			ownerWorkId: work.id,
			ownerRevision: work.revision,
			outcome,
			observed: summary || null,
			resultRef: finished ? work.id : null,
			...(!finished &&
				work.question && {
					question: {
						ref: work.question.id,
						prompt: work.question.prompt,
						expiresAtMs: work.question.expiresAt,
						released: work.released,
					},
				}),
		},
	};
	return { status: "known", observation };
}

export function createGoalClaude(ports: {
	claude: ClaudeCodeService;
	goals: GoalStore;
	capabilities: Capabilities;
	enabled(db: Database): boolean;
	sourceIsUser(db: Database, ref: string): boolean;
	notify?(db: Database, row: GoalProgress, observation: GoalObservation): void;
	sourcesCurrent: GoalProgressPorts["sourcesCurrent"];
}) {
	const { claude, goals, capabilities, enabled, sourcesCurrent } = ports;
	const root = claude.workingDirectory
		? realpathSync(claude.workingDirectory)
		: null;
	const binding = (db: Database) =>
		root ? bindingFor(db, capabilities) : null;
	const available = () => claude.availableInTransaction();

	function policy(db: Database, row: GoalProgress): GoalReadPolicyGrant | null {
		const target = binding(db);
		const sourceRef = row.state.sourceRef;
		if (
			!root ||
			!target ||
			!sourceRef ||
			!ports.sourceIsUser(db, sourceRef) ||
			!sourcesCurrent(db, row, [sourceRef])
		)
			return null;
		return {
			policyKey: "claude-code:workspace",
			policyGeneration: goalDigest([target, root, ordinaryClaudeWorkspaceRef]),
			workspace: root,
			impact: "workspace",
			toolchainRevisionId: target.toolchainRevisionId,
			scope: {
				version: 2,
				basis: { kind: "policy", revision: target.bindingRevisionId },
				workspaceRef: ordinaryClaudeWorkspaceRef,
				readablePaths: [],
				writablePaths: [],
				checks: [],
				expiresAtMs: null,
			},
		};
	}

	function usesWorkspace(db: Database, row: GoalProgress, permit: GoalPermit) {
		const expected = policy(db, row);
		return (
			!!expected &&
			expected.scope.version === 2 &&
			permit.scope.version === 2 &&
			!permit.revoked &&
			permit.policyKey === expected.policyKey &&
			permit.policyGeneration === expected.policyGeneration &&
			permit.workspace === expected.workspace &&
			permit.scope.workspaceRef === expected.scope.workspaceRef &&
			permit.scope.basis.kind === "policy" &&
			permit.scope.basis.revision === expected.scope.basis.revision &&
			permit.toolchainRevisionId === expected.toolchainRevisionId &&
			(permit.scope.expiresAtMs ?? Infinity) > Date.now()
		);
	}

	function modeInTransaction(db: Database, source: GoalExecutionSource) {
		const access = {
			principal: source.principal,
			scopeKeys: [source.scopeKey],
		};
		const row = goals.activeProgressInTransaction(db, access, source);
		if (
			!row ||
			!enabled(db) ||
			row.ledgerScope !== source.scopeKey ||
			(goals.goalScopeControlInTransaction(db, access, row.ledgerScope)
				?.allUntilMs ?? 0) > Date.now()
		)
			return null;
		const attempt = goals.goalAttemptInTransaction(
			db,
			access,
			row,
			source.attemptId,
		);
		const permit = goals.goalPermitInTransaction(
			db,
			access,
			row,
			source.permitId,
		);
		if (
			!attempt ||
			attempt.owner !== ordinaryGoalOwner ||
			!permit ||
			!usesWorkspace(db, row, permit) ||
			!["reserved", "running"].includes(attempt.outcome) ||
			attempt.permitRevision !== permit.revision ||
			permit.scope.version !== 2 ||
			attempt.bindingRevisionId !== permit.scope.basis.revision ||
			(attempt.id !== row.currentWorkId &&
				!goals
					.parkedGoalAttemptsInTransaction(db, access, row)
					.some(({ id }) => id === attempt.id)) ||
			codingCanonicalJSON(source) !==
				codingCanonicalJSON(goalExecutionSource(row, attempt, permit))
		)
			return null;
		const refs = new Set(
			attempt.step.evidenceRefs.filter((ref) => ref !== row.state.sourceRef),
		);
		const evidence = row.state.evidence.filter(({ ref }) => refs.has(ref));
		return evidence.length === refs.size &&
			sourcesCurrent(
				db,
				row,
				evidence.flatMap(({ sources = [] }) => sources),
			)
			? (operation(attempt) ?? null)
			: null;
	}
	claude.configureGoal({
		modeInTransaction,
		observeInTransaction(db, source, work) {
			if (!ports.notify || !modeInTransaction(db, source)) return;
			const access = {
				principal: source.principal,
				scopeKeys: [source.scopeKey],
			};
			const row = goals.activeProgressInTransaction(db, access, source);
			const attempt =
				row &&
				goals.goalAttemptInTransaction(db, access, row, source.attemptId);
			if (row && attempt)
				ports.notify(db, row, receipt(row, attempt, work).observation);
		},
	});

	const worker: GoalOwnerPort = {
		startInTransaction(db, row, attempt, permit) {
			const source = goalExecutionSource(row, attempt, permit);
			if (!modeInTransaction(db, source))
				return { status: "refused", reason: "goal_claude_source_inactive" };
			const work = claude.goal.startInTransaction(db, source);
			return work ? receipt(row, attempt, work) : { status: "unknown" };
		},
		lookupInTransaction(db, row, attempt) {
			const work = claude.goal.lookupInTransaction(db, identity(row, attempt));
			return work ? receipt(row, attempt, work) : { status: "absent" };
		},
		cancelInTransaction: (db, row, attempt) =>
			claude.goal.cancelInTransaction(db, identity(row, attempt)),
		answerWhileRunning: true,
		answerInTransaction: (db, row, attempt, _permit, answer) =>
			claude.goal.answerInTransaction(db, identity(row, attempt), answer),
		wake: claude.flush,
	};
	function surface(
		db: Database,
		row: GoalProgress,
		permit: GoalPermit,
	): GoalSurface {
		const target = binding(db);
		if (!target || !usesWorkspace(db, row, permit) || !available())
			return { capabilities: [], checks: [], watches: [] };
		return {
			capabilities: [
				{
					ref: read,
					effect: "read" as const,
					description:
						"通常の Claude Code で実装・作業規則・関連テストを読み、現状と検証方法を報告する。ファイル指定や追加許可は不要。",
				},
				{
					ref: edit,
					effect: "write" as const,
					description:
						"通常の Claude Code で必要な改修と確認を行う。既存実装で足りる場合は変更を加えない。リポジトリの作業規則に従う。",
				},
			].map(
				(item) =>
					({
						...item,
						allowedScope:
							"ホストの通常の開発 checkout。通常の作業規則と保護範囲を適用。",
						owner: ordinaryGoalOwner,
						bindingRevisionId: target.bindingRevisionId,
					}) satisfies GoalSurface["capabilities"][number],
			),
			checks: [],
			watches: [],
			verifyAfter: [read, edit],
		};
	}

	return {
		root,
		policy,
		binding,
		available,
		usesWorkspace,
		owners: { [ordinaryGoalOwner]: worker },
		surface,
		forgetInTransaction: (
			db: Database,
			row: GoalProgress,
			attempt: GoalAttempt,
		) =>
			attempt.owner === ordinaryGoalOwner &&
			claude.goal.forgetInTransaction(db, identity(row, attempt)),
	};
}
