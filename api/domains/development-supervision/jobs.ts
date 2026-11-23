import type { Database } from "bun:sqlite";
import { z } from "zod";
import { hash } from "../capabilities";
import type { InferencePort } from "../inference";
import type { QueueService } from "../queue";
import {
	childObservation,
	designFor,
	liveGrant,
	sourceCurrent,
} from "./authority";
import type {
	SupervisionChildObservation,
	SupervisionHost,
	SupervisionScope,
	SupervisionWorkspaceEvidence,
	SupervisionOwnedEdit,
} from "./contracts";
import {
	captureInference,
	coordinationScopes,
	designInput,
	inferAuthority,
	judgeWork,
	notesOf,
	planWork,
} from "./decisions";
import { earlierGoalEdit } from "./goal-edits";
import { adoptDesign, applyPlan, planningHeld } from "./planning";
import { grantOf, grantsOf, parentOf, parents } from "./repository";
import type { Grant, Parent, Task } from "./state";
import { finishTask } from "./views";
import { applyJudgement, evidenceOf, releaseConfirmed, scopeOf } from "./work";

export const jobKind = "development-supervision.advance";
const payloadSchema = z.strictObject({
	parentId: z.uuid(),
	generation: z.number().int().nonnegative(),
	kind: z.enum(["authority", "plan", "design", "capture", "judge"]),
	taskId: z.uuid().nullable(),
	taskGeneration: z.number().int().nonnegative().nullable(),
});
type Payload = z.infer<typeof payloadSchema>;
type JobKind = Payload["kind"];

export function enqueue(
	queue: QueueService,
	db: Database,
	parent: Parent,
	kind: JobKind,
	task?: Task,
) {
	const job = queue.enqueueInTransaction(db, {
		scope: "development-supervision",
		kind: jobKind,
		dedupeKey: crypto.randomUUID(),
		subjectRef: parent.id,
		payload: {
			parentId: parent.id,
			generation: parent.generation,
			kind,
			taskId: task?.id ?? null,
			taskGeneration: task?.generation ?? null,
		},
		lane: "background",
		concurrencyKey: `development-supervision:${parent.id}:${task?.id ?? "plan"}`,
		...(kind !== "capture" ? { resourceKey: "inference.llm" } : {}),
		deadlineAtMs: parent.deadline,
		maxAttempts: 1,
	}).job;
	if (task) task.jobId = job.id;
	else parent.jobId = job.id;
}

function current(
	db: Database,
	getHost: () => SupervisionHost | undefined,
	payload: Payload,
	jobId: string,
	now: number,
) {
	const host = getHost();
	const parent = parentOf(db, payload.parentId);
	if (
		!host ||
		!parent ||
		parent.generation !== payload.generation ||
		parent.stop ||
		parent.deadline <= now ||
		!sourceCurrent(host, db, parent)
	)
		return null;
	const task = payload.taskId
		? parent.tasks.find(({ id }) => id === payload.taskId)
		: undefined;
	if (
		payload.taskId
			? !task ||
				task.generation !== payload.taskGeneration ||
				task.jobId !== jobId
			: parent.jobId !== jobId
	)
		return null;
	return { host, parent, task };
}

type Prepared = { host: SupervisionHost; parent: Parent } & (
	| { kind: "authority"; requestId: string }
	| {
			kind: "plan";
			requestId: string;
			others: ReturnType<typeof coordinationScopes>;
			capabilities: { research: readonly string[]; skillSmith: boolean };
	  }
	| { kind: "design" }
	| {
			kind: "capture";
			scope: SupervisionScope;
			inherited?: SupervisionOwnedEdit;
	  }
	| {
			kind: "judge";
			requestId: string;
			task: Task;
			grant: Grant;
			child: SupervisionChildObservation;
			design: string;
			readScopes: { executionId: string; scope: SupervisionScope }[];
	  }
);

function priorReadScopes(
	db: Database,
	host: SupervisionHost,
	parent: Parent,
	task: Task,
) {
	if (!task.readEvidence.length) return [];
	return grantsOf(db, parent.id).flatMap((grant) => {
		if (
			grant.scope.mode !== "read" ||
			grant.revoked ||
			!grant.released ||
			grant.source.delegation.taskId !== task.id
		)
			return [];
		const executionId = childObservation(host, db, grant)?.executionId;
		return executionId &&
			task.readEvidence.some((proof) => proof.executionId === executionId)
			? [{ executionId, scope: grant.scope }]
			: [];
	});
}

async function captureForJudgement(
	input: Extract<Prepared, { kind: "judge" }>,
	signal: AbortSignal,
): Promise<SupervisionWorkspaceEvidence> {
	const { host, grant, task } = input;
	const observed = await host.workspace.capture(
		grant.scope,
		signal,
		task.before ?? undefined,
	);
	if (!task.readEvidence.length) return observed;
	const current = new Set<string>();
	for (const { executionId, scope } of input.readScopes) {
		const snapshot = await host.workspace.capture(scope, signal);
		for (const proof of task.readEvidence) {
			if (
				snapshot.preserved &&
				proof.executionId === executionId &&
				proof.targetRevision === snapshot.targetRevision &&
				proof.inputDigest === snapshot.inputDigest
			)
				current.add(proof.ref);
		}
	}
	return {
		...observed,
		staleReadRefs: task.readEvidence
			.map((item) => item.ref)
			.filter((ref) => !current.has(ref)),
	};
}

export function registerJobs({
	queue,
	inference,
	getHost,
	now,
	save,
	kick,
}: {
	queue: QueueService;
	inference: InferencePort;
	getHost: () => SupervisionHost | undefined;
	now: () => number;
	save: (db: Database, parent: Parent, previous: Parent) => void;
	kick: () => void;
}) {
	queue.registerHandler({
		kind: jobKind,
		payloadVersions: [1],
		schema: payloadSchema,
		recovery: "interrupt",
		prepareInTransaction(db, claim) {
			const pending = current(db, getHost, claim.payload, claim.jobId, now());
			if (!pending) return { status: "stale", reason: "supervision_job_stale" };
			const { host, parent, task } = pending;
			const kind = claim.payload.kind;
			if (kind === "capture" && task) {
				const proposed = scopeOf(parent, task);
				const scope = host.workspace.resolveScope
					? host.workspace.resolveScope(proposed)
					: proposed;
				if (scope)
					return {
						status: "ready",
						input: {
							kind,
							host,
							parent,
							scope,
							inherited: earlierGoalEdit(db, parent, scope),
						} satisfies Prepared,
					};
				return { status: "stale", reason: "supervision_scope_unavailable" };
			}
			const previous = structuredClone(parent);
			if (parent.calls >= parent.limits.calls)
				throw new Error("supervision_call_limit");
			parent.calls++;
			save(db, parent, previous);
			if (kind === "design" && parent.plan)
				return {
					status: "ready",
					input: { kind, host, parent } satisfies Prepared,
				};
			const requestId = captureInference(db, inference, parent, now());
			if (!requestId) throw new Error("supervision_inference_unavailable");
			if (kind === "authority")
				return {
					status: "ready",
					input: { kind, host, parent, requestId } satisfies Prepared,
				};
			if (kind === "plan")
				return {
					status: "ready",
					input: {
						kind,
						host,
						parent,
						requestId,
						others: parents(db, {
							pending: true,
							workspaceRef: parent.workspace.workspaceRef,
						})
							.filter(({ id }) => id !== parent.id)
							.flatMap((owner) => coordinationScopes(owner.tasks)),
						capabilities: {
							research: (["web.note", "inspect.source"] as const).filter(
								(kind) => host.research.targetInTransaction(db, kind),
							),
							skillSmith: !!host.research.skillSmith,
						},
					} satisfies Prepared,
				};
			if (kind === "judge" && task?.grantRef) {
				const grant = grantOf(db, task.grantRef);
				const child = grant ? childObservation(host, db, grant) : null;
				const design = designFor(host, db, parent, task.designRevision);
				if (
					grant &&
					child &&
					design &&
					releaseConfirmed(host, db, grant, child)
				)
					return {
						status: "ready",
						input: {
							kind,
							host,
							parent,
							requestId,
							task,
							grant,
							design: design.markdown,
							child: { ...child, evidence: evidenceOf(grant, child) },
							readScopes: priorReadScopes(db, host, parent, task),
						} satisfies Prepared,
					};
			}
			return { status: "stale", reason: "supervision_job_authority_invalid" };
		},
		async execute(input: Prepared, { signal }) {
			const { host, parent, kind } = input;
			switch (kind) {
				case "authority":
					return {
						kind,
						...(await inferAuthority(
							inference,
							input.requestId,
							parent,
							signal,
						)),
					};
				case "plan":
					return {
						kind,
						...(await planWork(
							inference,
							input.requestId,
							parent,
							input.others,
							input.capabilities,
							signal,
						)),
					};
				case "design": {
					const plan = parent.plan!;
					const guides =
						plan.guideQuery && parent.source.origin !== "goal"
							? (
									(await host.research.skillSmith?.(
										plan.guideQuery,
										parent.source,
										signal,
									)) ?? []
								).slice(0, 4)
							: [];
					const notes = [...notesOf(parent), ...guides];
					return {
						kind,
						guides,
						output: await host.design.prepare(
							designInput(parent, plan, notes),
							notes.map(({ evidence }) => evidence),
							signal,
						),
					};
				}
				case "capture":
					return {
						kind,
						output: await host.workspace.capture(
							input.scope,
							signal,
							undefined,
							input.inherited,
						),
					};
				case "judge": {
					const { task, child } = input;
					const observed = await captureForJudgement(input, signal);
					const decision = await judgeWork(
						inference,
						input.requestId,
						parent,
						task,
						child,
						observed,
						input.design,
						signal,
					);
					const confirmed = await captureForJudgement(input, signal);
					return {
						kind,
						observed: {
							...confirmed,
							staleReadRefs: [
								...new Set([
									...(observed.staleReadRefs ?? []),
									...(confirmed.staleReadRefs ?? []),
								]),
							],
							preserved:
								confirmed.preserved &&
								observed.preserved &&
								confirmed.inputDigest === observed.inputDigest,
						},
						...decision,
					};
				}
			}
		},
		settleInTransaction(db, claim, prepared, outcome) {
			const currentWork = current(
				db,
				getHost,
				claim.payload,
				claim.jobId,
				now(),
			);
			if (!currentWork) return "stale";
			const { host, parent, task } = currentWork;
			const previous = structuredClone(parent);
			if (task) task.jobId = null;
			else parent.jobId = null;
			const next = outcome.type === "success" ? outcome.result : null;
			if (
				!next ||
				("receipt" in next &&
					(!next.receipt || !inference.acceptInTransaction?.(db, next.receipt)))
			) {
				const reason =
					"監督の判断または観測を確定できません。再開には新しい条件が必要です。";
				if (task) finishTask(task, "partial", reason);
				else planningHeld(parent, reason);
			} else if (next.kind === "authority") {
				const selected = parent.tasks.find(
					({ id }) => id === parent.pendingTaskId,
				);
				if (selected) selected.ceiling = next.output.mode;
				else parent.ceiling = next.output.mode;
				if (parent.source.origin === "goal") return "stale";
				parent.context = (
					host.research.contextInTransaction?.(
						db,
						parent.source,
						parent.references,
					) ?? []
				).slice(0, 12);
				parent.phase = "plan";
				parent.reason = "開発作業を整理中";
			} else if (next.kind === "plan") applyPlan(host, db, parent, next.output);
			else if (next.kind === "design")
				adoptDesign(host, db, parent, next.output, next.guides);
			else if (next.kind === "capture" && task) {
				if (
					!next.output.preserved ||
					next.output.targetRevision !== scopeOf(parent, task).targetRevision ||
					!next.output.inputDigest
				)
					finishTask(
						task,
						"partial",
						"対象の版または既存差分の基準を確かめられません。",
					);
				else task.before = next.output;
			} else if (next.kind === "judge" && task && prepared?.kind === "judge") {
				const grant = task.grantRef ? grantOf(db, task.grantRef) : null;
				const observed = grant ? childObservation(host, db, grant) : null;
				if (
					!grant ||
					hash(grant) !== hash(prepared.grant) ||
					!observed ||
					observed.executionId !== prepared.child.executionId ||
					hash([
						observed.view.status,
						observed.view.result,
						evidenceOf(grant, observed),
					]) !==
						hash([
							prepared.child.view.status,
							prepared.child.view.result,
							prepared.child.evidence,
						]) ||
					!releaseConfirmed(host, db, grant, observed) ||
					!liveGrant(host, db, grant, parent, now())
				)
					finishTask(
						task,
						"partial",
						"受入判断時の子仕事、対象版または証跡が更新されました。",
					);
				else
					applyJudgement(
						parent,
						task,
						grant,
						observed,
						next.observed,
						next.output,
					);
			}
			save(db, parent, previous);
			return "applied";
		},
		afterCommit: kick,
		cancelInTransaction() {},
	});
}
