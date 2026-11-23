import type { Database } from "bun:sqlite";
import type { InputContext } from "eumenes-agency";
import type { GoalStepContext } from "eumenes-agency/agenda";
import {
	GOAL_ANALYSIS_MS,
	canResolveGoalQuestion,
	goalOwnerQuestionCriteria,
	type GoalAttempt,
	type GoalPermit,
	type GoalProgress,
	type GoalStore,
	type GoalWatch,
	type StoredGoal,
} from "eumenes-agency/agenda/runtime";
import { canonicalJson, sha256Hex } from "../../infrastructure/digest";

export const goalDigest = (value: unknown) =>
	sha256Hex(
		canonicalJson(value, { omitUndefined: true, keyOrder: "codeUnit" }),
	);
export const goalAccess = ({
	principal,
	ledgerScope,
}: Pick<GoalProgress, "principal" | "ledgerScope">) => ({
	principal,
	scopeKeys: [ledgerScope],
});
export const goalEditAvailabilityWatch = "initial-analysis";
export type GoalCapability = GoalStepContext["capabilities"][number] & {
	readonly owner: string;
	readonly bindingRevisionId: string;
	readonly effect: "read" | "write";
};
export type GoalCheckCandidate = GoalStepContext["checks"][number] & {
	readonly permitId?: string;
};
type BoundCapability = GoalCapability & {
	readonly operationRef: string;
	readonly permitId: string;
	readonly permitRevision: number;
};
export interface GoalSurface {
	readonly capabilities: readonly GoalCapability[];
	readonly watches: readonly GoalWatch[];
	readonly checks: readonly GoalCheckCandidate[];
	readonly verifyAfter?: readonly string[];
}

function matters(attempt: GoalAttempt, open: ReadonlySet<string>) {
	return attempt.step.criterionIds.some((id) => open.has(id));
}

function needsReview(progress: GoalProgress, attempts: readonly GoalAttempt[]) {
	const open = new Set(
		progress.state.criteria
			.filter(({ status }) => status === "open")
			.map(({ id }) => id),
	);
	const finished = attempts.filter(
		({ outcome }) => outcome !== "reserved" && outcome !== "running",
	);
	const fresh = finished
		.slice(progress.state.reviewedAttemptCount)
		.filter((attempt) => matters(attempt, open));
	const countByCriterion = new Map<string, number>();
	for (const attempt of fresh) {
		for (const id of new Set(attempt.step.criterionIds))
			if (open.has(id))
				countByCriterion.set(id, (countByCriterion.get(id) ?? 0) + 1);
	}
	if ([...countByCriterion.values()].some((count) => count >= 3)) return true;
	const failures = fresh.filter(
		({ outcome }) => outcome === "failed" || outcome === "rejected",
	);
	const last = failures.at(-1);
	const summaries = new Map(
		progress.state.evidence.map(({ ref, summary }) => [ref, summary]),
	);
	const material = (attempt: GoalAttempt) =>
		[
			...new Set(
				attempt.evidenceRefs.flatMap((ref) => {
					const summary = summaries.get(ref);
					return summary ? [summary] : [];
				}),
			),
		].sort();
	const latest = last ? material(last) : [];
	return (
		last !== undefined &&
		failures
			.slice(0, -1)
			.some(
				(attempt) =>
					attempt.step.capabilityRef === last.step.capabilityRef &&
					attempt.permitId === last.permitId &&
					attempt.permitRevision === last.permitRevision &&
					((latest.length > 0 &&
						goalDigest(material(attempt)) === goalDigest(latest)) ||
						(attempt.step.request === last.step.request &&
							attempt.observed === last.observed &&
							goalDigest(attempt.evidenceRefs) ===
								goalDigest(last.evidenceRefs))),
			)
	);
}

type GoalSnapshotPorts = {
	readonly goals: GoalStore;
	readonly surface: (
		db: Database,
		progress: GoalProgress,
		permit: GoalPermit | null,
	) => GoalSurface;
	readonly checks?: (
		db: Database,
		progress: GoalProgress,
	) => readonly GoalCheckCandidate[];
	readonly sourcesCurrent: (
		db: Database,
		progress: GoalProgress,
		sources: readonly string[],
	) => boolean;
	readonly sourceText?: (db: Database, id: string) => string | null;
	readonly ownerAvailable: (owner: string) => boolean;
	readonly nowMs: number;
};

export function currentGoalPermits(
	db: Database,
	deps: Pick<GoalSnapshotPorts, "goals" | "sourcesCurrent" | "nowMs">,
	row: GoalProgress,
) {
	return deps.goals
		.goalPermitsInTransaction(db, goalAccess(row), row)
		.filter(
			(permit) =>
				(permit.scope.expiresAtMs ?? Infinity) > deps.nowMs &&
				(permit.scope.basis.kind !== "message" ||
					deps.sourcesCurrent(db, row, permit.scope.basis.sourceRefs)),
		);
}

function offeredSurface(
	db: Database,
	deps: GoalSnapshotPorts,
	row: GoalProgress,
) {
	const permits = currentGoalPermits(db, deps, row);
	const surfaces = permits.map((permit) => ({
		permit,
		surface: deps.surface(db, row, permit),
	}));
	const analysisUntil = row.state.startedAt + GOAL_ANALYSIS_MS;
	const allowed: BoundCapability[] = surfaces.flatMap(({ permit, surface }) =>
		surface.capabilities
			.filter(
				(item) =>
					deps.ownerAvailable(item.owner) &&
					(item.effect === "read" ||
						(row.state.design !== null && deps.nowMs >= analysisUntil)),
			)
			.map((item) => ({
				...item,
				operationRef: item.ref,
				ref:
					permits.length === 1
						? item.ref
						: "goal-capability:" +
							goalDigest([
								permit.id,
								permit.revision,
								item.bindingRevisionId,
								item.ref,
							]),
				description: `作業先 ${permit.scope.workspaceRef}。${item.description}`,
				permitId: permit.id,
				permitRevision: permit.revision,
			})),
	);
	const defaults = permits.length ? undefined : deps.surface(db, row, null);
	const watches = [
		...new Map(
			(
				defaults?.watches ?? surfaces.flatMap(({ surface }) => surface.watches)
			).map((item) => [item.ref, item]),
		).values(),
	];
	const editPermit = permits.find(
		(permit) => permit.scope.writablePaths.length,
	);
	if (editPermit && deps.nowMs < analysisUntil)
		watches.push({
			ref: goalEditAvailabilityWatch,
			condition:
				"保存済みの変更許可は有効です。初回分析期限に到達すると、許可範囲の変更能力を再確認します。",
			dueAtMs: analysisUntil,
		});
	const checks =
		deps.checks?.(db, row) ??
		defaults?.checks ??
		surfaces.flatMap(({ surface }) => surface.checks);
	return {
		permits,
		surfaces,
		allowed,
		watches,
		analysisUntil,
		editPermit,
		checks,
	};
}

export function prepareGoalSnapshot(
	db: Database,
	deps: GoalSnapshotPorts,
	progress: GoalProgress,
	goal: StoredGoal,
) {
	const access = goalAccess(progress);
	const {
		permits,
		surfaces,
		allowed,
		watches,
		analysisUntil,
		editPermit,
		checks: offeredChecks,
	} = offeredSurface(db, deps, progress);
	const evidence = progress.state.evidence.filter(
		({ sources }) => !sources || deps.sourcesCurrent(db, progress, sources),
	);
	const originRef = progress.state.sourceRef;
	const original = originRef && deps.sourceText?.(db, originRef);
	if (original)
		evidence.unshift({
			ref: originRef,
			version: String(goal.revision),
			digest: goalDigest(original),
			summary: original,
			sources: [originRef],
		});
	const evidenceIds = new Set(evidence.map(({ ref }) => ref));
	const blocked = goalOwnerQuestionCriteria(
		progress.state.questions,
		progress.state.criteria,
	);
	const criteria = progress.state.criteria
		.filter(({ id }) => !blocked.has(id))
		.map(({ id, text, status, evidenceRefs }) => ({
			id,
			text,
			status: evidenceRefs.some((ref) => !evidenceIds.has(ref))
				? ("open" as const)
				: status,
			evidenceRefs: evidenceRefs.filter((ref) => evidenceIds.has(ref)),
		}));
	const allAttempts = deps.goals.goalAttemptsInTransaction(
		db,
		access,
		progress,
	);
	const open = new Set(
		criteria.filter(({ status }) => status === "open").map(({ id }) => id),
	);
	const latest = allAttempts.find(
		({ id }) => id === progress.state.lastDecision?.resultRef,
	);
	const checks = offeredChecks
		.map((check) => ({
			...check,
			criterionIds: check.criterionIds.filter((id) => !blocked.has(id)),
		}))
		.filter(({ criterionIds }) => criterionIds.length);
	const latestSurface =
		latest &&
		surfaces.find(
			({ permit }) =>
				permit.id === latest.permitId &&
				permit.revision === latest.permitRevision,
		)?.surface;
	const machineChecks = latest
		? checks.filter(({ permitId }) => permitId === latest.permitId)
		: [];
	const verificationChecks = machineChecks.length
		? machineChecks
		: checks.filter(({ permitId }) => !permitId);
	const toVerify =
		latestSurface &&
		latest?.outcome === "succeeded" &&
		latest.resultRef &&
		latestSurface.verifyAfter?.includes(
			latest.operationRef ?? latest.step.capabilityRef,
		)
			? [...open].filter((id) =>
					verificationChecks.some(({ criterionIds }) =>
						criterionIds.includes(id),
					),
				)
			: [];
	const verificationRequired =
		latest && toVerify.length
			? { attemptRef: latest.id, criterionIds: toVerify }
			: null;
	const capabilities = verificationRequired ? [] : allowed;
	const attempts = allAttempts
		.filter(
			(attempt) => matters(attempt, open) || attempt === allAttempts.at(-1),
		)
		.slice(-24)
		.map((attempt) => ({
			ref: attempt.id,
			criterionIds: attempt.step.criterionIds,
			capabilityRef: attempt.step.capabilityRef,
			request: attempt.step.request,
			expectedObservation: attempt.step.expectedObservation,
			outcome: attempt.outcome,
			observed: attempt.observed,
			...(attempt.ownerWorkId !== null && attempt.ownerRevision !== null
				? {
						savedReceipt: {
							ownerWorkId: attempt.ownerWorkId,
							ownerRevision: attempt.ownerRevision,
							resultRef: attempt.resultRef,
						},
					}
				: {}),
			evidenceRefs: attempt.evidenceRefs.filter((ref) => evidenceIds.has(ref)),
		}));
	const configuration = progress.state.configuration;
	const openQuestions = progress.state.questions
		.filter(({ answeredBy, resolution }) => !answeredBy && !resolution)
		.map((question) => {
			const canResolve = canResolveGoalQuestion(progress.state, question);
			return {
				ref: question.ref,
				criterionIds: [...question.criterionIds],
				question: question.question,
				canResolve,
				...(canResolve &&
					configuration && { configurationRef: configuration.ref }),
			};
		});
	const sources = [
		...new Set([
			...(progress.state.sourceRef ? [progress.state.sourceRef] : []),
			...progress.state.questions.flatMap(({ answeredBy }) =>
				answeredBy ? [answeredBy] : [],
			),
			...evidence.flatMap((item) => item.sources ?? []),
			...permits.flatMap(({ scope }) =>
				scope.basis.kind === "message" ? scope.basis.sourceRefs : [],
			),
		]),
	];
	const input: InputContext = {
		sources,
		complete: progress.state.sourceRef !== null,
	};
	const state: Omit<GoalStepContext, "contextId"> = {
		version: 1,
		goal: {
			id: goal.goalId,
			revision: goal.revision,
			desiredState: goal.desiredState,
			sourceRef: progress.state.sourceRef,
		},
		progressVersion: progress.progressVersion,
		...(verificationRequired && { verificationRequired }),
		criteria,
		attempts,
		evidence: evidence.map(({ ref, version, summary }) => ({
			ref,
			version,
			summary,
		})),
		capabilities: capabilities.map(({ ref, description, allowedScope }) => ({
			ref,
			description,
			allowedScope,
		})),
		watches: watches.map(({ ref, condition, dueAtMs }) => ({
			ref,
			condition,
			dueAtMs,
		})),
		checks: (verificationRequired ? verificationChecks : checks).map(
			({ ref, description, criterionIds }) => ({
				ref,
				description,
				criterionIds,
			}),
		),
		...(configuration && {
			configuration: { ref: configuration.ref, summary: configuration.summary },
		}),
		openQuestions,
		reviewRequired: needsReview(progress, allAttempts),
	};
	const control = deps.goals.goalScopeControlInTransaction(
		db,
		access,
		progress.ledgerScope,
	);
	const editAvailability =
		editPermit && deps.nowMs < analysisUntil
			? {
					workspaceRef: editPermit.scope.workspaceRef,
					permittedPaths: [...editPermit.scope.writablePaths],
					notBeforeMs: analysisUntil,
					reason: "初回分析の期限までの保留。本人の変更許可は保存済み。",
				}
			: null;
	const context: GoalStepContext = {
		...state,
		...(editAvailability && {
			editAvailability: { ...editAvailability, nowMs: deps.nowMs },
		}),
		contextId: goalDigest([
			progress.principal,
			progress.ledgerScope,
			state,
			permits.map(({ id, revision }) => [id, revision]),
			capabilities,
			watches,
			input,
			control?.generation,
			editAvailability,
			evidence.map(({ digest }) => digest),
		]),
	};
	return {
		context,
		input,
		capabilities,
		watches,
		controlGeneration: control?.generation ?? 0,
	};
}
