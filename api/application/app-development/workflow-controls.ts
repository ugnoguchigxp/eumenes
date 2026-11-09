import type { Database } from "bun:sqlite";
import { z } from "zod";
import type { AgentRuntime } from "../../domains/agent-runtime";
import type { AppDevelopment } from "../../domains/app-development";
import type { Capabilities } from "../../domains/capabilities";
import { gitChanges } from "../../domains/git-observation";
import type { MarkdownService } from "../../domains/markdown";
import {
	activeCheckpointWorkflowInTransaction,
	activeWorkflowRunsInTransaction,
	adoptWorkflowCheckpointsInTransaction,
	admitWorkflowInTransaction,
	finishWorkflowInTransaction,
	latestWorkflowRunInTransaction,
	linkWorkflowScheduleInTransaction,
	markWorkflowPublicationCheckInTransaction,
	recordWorkflowParentInTransaction,
	setWorkflowJobInTransaction,
	stageWorkflowPublicationInTransaction,
	unlinkWorkflowScheduleInTransaction,
	workflowCheckpointCandidates,
	workflowRevisionInTransaction,
	workflowRunInTransaction,
	workflowScheduleInTransaction,
} from "../../domains/pipelines";
import type { QueueService } from "../../domains/queue";
import type { SchedulerService } from "../../domains/scheduler";
import { toErrorCode } from "../../infrastructure/error-code";
import { getLogger } from "../../infrastructure/logger";
import type { SqliteStore } from "../../infrastructure/sqlite";
import type { WorkflowExecutionAuthority } from "../pipelines/workflow-execution-source";
import type { AppWorkflowControls } from "./app-development-adapter";
import {
	journalDestination,
	markdownDraft,
	workflowCheckpointOwner,
	type createWorkflowOperations,
} from "./workflow-operations";

type Run = NonNullable<ReturnType<typeof workflowRunInTransaction>>;
type App = NonNullable<ReturnType<AppDevelopment["app"]>>;
const jobKind = "workflow.progress";
const targetKind = "workflow.run";
const jobInput = z.strictObject({ scope: z.string(), runId: z.uuid() });
const scheduleTarget = z.strictObject({
	definitionId: z.uuid(),
	revision: z.number().int().positive(),
});
const publicationSchema = z.strictObject({
	checked: z.literal([0, 1]).optional(),
	candidates: z.array(
		z.strictObject({
			key: z.string(),
			previous: z.string().nullable(),
			current: z.string(),
		}),
	),
});
const inProgress = (run: Run) =>
	["accepted", "running", "publishing"].includes(run.state);

type WorkflowDependencies = {
	store: SqliteStore;
	queue: QueueService;
	scheduler: SchedulerService;
	apps: AppDevelopment;
	capabilities: Capabilities;
	agents: AgentRuntime["executions"];
	authority: WorkflowExecutionAuthority;
	operations: ReturnType<typeof createWorkflowOperations>;
	markdown: MarkdownService;
	destination(): { namespace: string; path: string } | null;
	now?: () => number;
};

export function createAppWorkflowControls(deps: WorkflowDependencies) {
	const { store, queue, scheduler, apps, authority, agents, markdown } = deps;
	const now = deps.now ?? Date.now;
	const scope = apps.scope;
	const load = (db: Database, id: string) =>
		workflowRunInTransaction(db, scope, id);
	const saved = (db: Database, app: App) =>
		app.workflowRevision
			? workflowRevisionInTransaction(
					db,
					scope,
					app.appId,
					app.workflowRevision,
				)
			: null;
	function enqueue(
		db: Database,
		runId: string,
		version: number,
		availableAtMs = now(),
	) {
		return queue.enqueueInTransaction(db, {
			scope,
			kind: jobKind,
			subjectRef: runId,
			dedupeKey: `${runId}:${version}`,
			lane: "background",
			payload: { scope, runId },
			availableAtMs,
			maxAttempts: 3,
		}).job.id;
	}
	function tickAgain(db: Database, run: Run, delay = 1000) {
		const id = enqueue(db, run.runId, run.version, now() + delay);
		if (!setWorkflowJobInTransaction(db, scope, run.runId, run.version, id))
			throw new Error("workflow_state_changed");
	}
	function fail(
		db: Database,
		run: Run,
		code: string,
		state: "failed" | "cancelled" | "expired" = "failed",
	) {
		const source = authority.sourceInTransaction(db, scope, run.runId);
		if (source && run.parentId)
			agents.cancelWorkflowInTransaction(db, run.parentId, source);
		if (run.state === "publishing")
			markdown.generated.cancelInTransaction(db, run.runId);
		finishWorkflowInTransaction(db, scope, run.runId, state, run.version, {
			code,
		});
	}
	const progress = createWorkflowProgress(deps, { load, fail, tickAgain });
	registerWorkflowProgressJob(deps, { load, fail, progress });
	function admit(
		db: Database,
		workflowId: string,
		revision: number,
		origin:
			| { kind: "manual"; operationId: string }
			| { kind: "schedule"; operationId: string; scheduledAt: number },
		inputs: unknown,
	) {
		const previous = workflowRevisionInTransaction(
			db,
			scope,
			workflowId,
			revision,
		);
		const refs = { scope, workflowId };
		return admitWorkflowInTransaction(
			db,
			{ ...refs, revision, origin, inputs },
			{
				nowMs: now(),
				deadlineMs:
					now() +
					(previous?.value.definition.publish.kind === "dataset"
						? 60_000
						: 480_000),
				schema: (ref) => deps.operations.schema(db, ref, refs),
				authorized: (_input, def) =>
					def.value.definition.publish.kind === "dataset" ||
					!!deps.destination(),
				enqueue: ({ runId }) => enqueue(db, runId, 0),
			},
		);
	}
	scheduler.registerTarget({
		kind: targetKind,
		version: 1,
		publicCreate: false,
		schema: scheduleTarget,
		deferReasonInTransaction(db, occurrence) {
			const app = apps.app(db, occurrence.payload.definitionId);
			if (!app) return "workflow_unavailable";
			return activeCheckpointWorkflowInTransaction(db, scope, app.appId)
				? "workflow_busy"
				: null;
		},
		materializeInTransaction(db, occurrence) {
			const { definitionId, revision } = occurrence.payload;
			const binding = workflowScheduleInTransaction(
				db,
				scope,
				definitionId,
				occurrence.scheduleId,
			);
			if (
				!apps.app(db, definitionId) ||
				binding?.definition_revision !== revision
			)
				throw new Error("workflow_schedule_forbidden");
			const result = admit(
				db,
				definitionId,
				revision,
				{
					kind: "schedule",
					operationId: occurrence.occurrenceId,
					scheduledAt: occurrence.scheduledAtMs,
				},
				{},
			);
			if (!result.jobId) throw new Error("workflow_busy");
			return { jobId: result.jobId, subjectRef: result.runId };
		},
	});
	function stop(db: Database, app: App) {
		const prior = workflowScheduleInTransaction(db, scope, app.appId);
		if (!prior) return null;
		const current = scheduler.getInTransaction(db, prior.schedule_id);
		if (current && ["active", "paused"].includes(current.state))
			scheduler.cancelInTransaction(db, current.id, current.revision);
		unlinkWorkflowScheduleInTransaction(
			db,
			scope,
			app.appId,
			prior.schedule_id,
		);
		return prior.schedule_id;
	}
	const controls: AppWorkflowControls = {
		run(db, app, operationId, values) {
			const revision = saved(db, app);
			if (!revision) throw new Error("workflow_unavailable");
			const result = admit(
				db,
				app.appId,
				revision.revision,
				{ kind: "manual", operationId },
				values,
			);
			return {
				projectId: app.appId,
				state: result.jobId ? "accepted" : "busy",
				runId: result.runId,
			};
		},
		schedule(db, app, operationId, anchor) {
			const revision = saved(db, app);
			if (
				!revision ||
				revision.value.definition.trigger !== "schedule" ||
				(revision.value.definition.publish.kind === "markdown" &&
					!deps.destination())
			)
				throw new Error("workflow_schedule_forbidden");
			stop(db, app);
			const schedule = scheduler.createInTransaction(db, {
				requestId: operationId,
				target: {
					kind: targetKind,
					payload: { definitionId: app.appId, revision: revision.revision },
				},
				schedule: { type: "interval", anchor, intervalMs: 86_400_000 },
				misfirePolicy: "coalesce",
				graceMs: 0,
			});
			linkWorkflowScheduleInTransaction(
				db,
				scope,
				app.appId,
				revision.revision,
				schedule.id,
			);
			return {
				projectId: app.appId,
				state: "scheduled",
				scheduleId: schedule.id,
			};
		},
		stop(db, app) {
			return {
				projectId: app.appId,
				state: "stopped",
				scheduleId: stop(db, app),
			};
		},
		cancel(db, app, runId) {
			const run = load(db, runId);
			if (!run || run.workflowId !== app.appId)
				throw new Error("workflow_run_not_found");
			if (inProgress(run)) {
				fail(db, run, "workflow_cancelled", "cancelled");
				if (run.jobId)
					queue.cancelInTransaction(db, run.jobId, "workflow_cancelled");
			}
			return { projectId: app.appId, state: "cancelled", runId };
		},
		reconcile(db, app, runId) {
			const run = load(db, runId);
			if (
				!run ||
				run.workflowId !== app.appId ||
				run.state !== "publishing" ||
				(run.result as { code?: string } | null)?.code !==
					"workflow_markdown_needs_confirmation"
			)
				throw new Error("workflow_confirmation_unavailable");
			if (
				!markWorkflowPublicationCheckInTransaction(
					db,
					scope,
					run.runId,
					run.version,
					false,
				)
			)
				throw new Error("workflow_state_changed");
			return { projectId: app.appId, state: "reconciling", runId };
		},
		stopForDeletion(db, app) {
			stop(db, app);
			for (const item of activeWorkflowRunsInTransaction(db)) {
				if (item.scope !== scope) continue;
				const run = load(db, item.id);
				if (run?.workflowId === app.appId) controls.cancel(db, app, run.runId);
			}
		},
		view: createWorkflowView(scope, scheduler),
		wake() {
			queue.wake();
			scheduler.wake();
			markdown.generated.flush();
		},
	};
	return {
		...controls,
		async recover() {
			await store.write((db) => {
				for (const item of activeWorkflowRunsInTransaction(db).filter(
					(item) => item.scope === scope,
				)) {
					const run = load(db, item.id)!;
					const job = run.jobId ? queue.getInTransaction(db, run.jobId) : null;
					if (!job || !["queued", "running", "retry_wait"].includes(job.state))
						tickAgain(db, run, 0);
				}
			});
		},
		validDocument(db: Database, id: string, ref: string) {
			return (
				ref === `workflow:${id}` &&
				load(db, id)?.state === "publishing" &&
				!!authority.sourceInTransaction(db, scope, id)
			);
		},
	};
}

type Load = (db: Database, id: string) => Run | null;
type Fail = (
	db: Database,
	run: Run,
	code: string,
	state?: "failed" | "cancelled" | "expired",
) => void;
type Continue = (db: Database, run: Run, delay?: number) => void;
function createWorkflowProgress(
	deps: WorkflowDependencies,
	ports: { load: Load; fail: Fail; tickAgain: Continue },
) {
	const { authority, agents, markdown } = deps;
	const { load, fail, tickAgain } = ports;
	const scope = deps.apps.scope;
	const now = deps.now ?? Date.now;
	return function progress(db: Database, run: Run) {
		if (run.deadlineMs <= now())
			return fail(db, run, "workflow_deadline_exceeded", "expired");
		const source = authority.sourceInTransaction(db, scope, run.runId);
		const snapshot = source && authority.runInTransaction(db, source);
		if (!source || !snapshot)
			return fail(db, run, "workflow_authority_revoked");
		const { definition } = snapshot.saved.value;
		if (run.state === "accepted") {
			const control = deps.capabilities
				.toolchainsInTransaction(db)
				.find((item) => item.id === "pipeline.execute");
			if (!control) return fail(db, run, "pipeline_unavailable");
			const parent = agents.startPipelineInTransaction(db, {
				source,
				toolchainRevisionId: control.revisionId,
				deadline: run.deadlineMs,
				requestId: run.runId,
			});
			if (
				!recordWorkflowParentInTransaction(
					db,
					scope,
					run.runId,
					parent.id,
					run.version,
				)
			)
				throw new Error("workflow_state_changed");
			return tickAgain(db, load(db, run.runId)!);
		}
		if (run.state === "publishing") {
			const receipt = markdown.generated.currentInTransaction(db, run.runId);
			if (!receipt || receipt.state === "cancelled")
				return fail(db, run, "workflow_markdown_missing");
			if (receipt.state === "pending") return tickAgain(db, run, 800);
			if (receipt.archive.state === "unknown") return tickAgain(db, run, 3000);

			if (receipt.archive.state !== "saved" || !receipt.archive.sourceId)
				return fail(
					db,
					run,
					receipt.archive.code ?? "workflow_markdown_unsaved",
				);
			const { candidates } = publicationSchema.parse(run.publication);
			if (
				!adoptWorkflowCheckpointsInTransaction(
					db,
					workflowCheckpointOwner(scope, run.workflowId, definition),
					candidates,
				)
			)
				return fail(db, run, "workflow_checkpoint_conflict");
			finishWorkflowInTransaction(
				db,
				scope,
				run.runId,
				"completed",
				run.version,
				{
					kind: "markdown",
					sourceId: receipt.archive.sourceId,
					path: receipt.path,
					checkpointCount: candidates.length,
				},
			);
			return;
		}
		const view = run.parentId
			? agents.viewInTransaction(db, run.parentId)
			: null;
		if (!view || !run.parentId)
			return fail(db, run, "workflow_pipeline_missing");
		if (["queued", "deciding", "waiting_child"].includes(view.status))
			return tickAgain(db, run);
		if (view.status !== "completed")
			return fail(db, run, view.result?.code ?? "workflow_pipeline_failed");
		const outputs = agents.workflowOutputsInTransaction(
			db,
			run.parentId,
			source,
		);
		if (!outputs) return fail(db, run, "workflow_output_missing");
		const publish = definition.publish;
		const schema = deps.operations.schema(db, publish.schemaRef, {
			scope,
			workflowId: run.workflowId,
		});
		if (!schema) return fail(db, run, "workflow_schema_unavailable");
		const value = schema.parse(outputs[publish.from]);
		if (publish.kind === "dataset") {
			finishWorkflowInTransaction(
				db,
				scope,
				run.runId,
				"completed",
				run.version,
				{ kind: "dataset", value },
			);
			return;
		}
		const destination =
			publish.destinationRef === journalDestination ? deps.destination() : null;
		if (!destination) return fail(db, run, "workflow_destination_unavailable");
		const draft = markdownDraft.parse(value);
		if (!definition.checkpoint)
			return fail(db, run, "workflow_checkpoint_required");
		const observations = gitChanges.parse(outputs[definition.checkpoint.from]);
		const candidates = workflowCheckpointCandidates(
			observations.units,
			draft.coverage,
			draft.evidenceRefs,
		);
		if (
			!stageWorkflowPublicationInTransaction(
				db,
				scope,
				run.runId,
				run.version,
				{ candidates },
			)
		)
			throw new Error("workflow_state_changed");
		const day = new Intl.DateTimeFormat("sv-SE", {
			timeZone: "Asia/Tokyo",
		}).format(run.scheduledAtMs ?? now());
		markdown.generated.startInTransaction(db, {
			id: run.runId,
			ownerRef: `workflow:${run.runId}`,
			sourceRunId: run.runId,
			conversationId: source.conversationId,
			title: draft.title,
			markdown: draft.markdown,
			namespace: destination.namespace,
			path: `${destination.path}/${day}-${run.runId}.md`,
		});
		return tickAgain(db, load(db, run.runId)!, 800);
	};
}

function createWorkflowView(scope: string, scheduler: SchedulerService) {
	return function view(db: Database, app: App) {
		const latest = app.workflowRevision
			? latestWorkflowRunInTransaction(
					db,
					scope,
					app.appId,
					app.workflowRevision,
				)
			: null;
		const previous =
			latest &&
			latest.state !== "completed" &&
			app.workflowRevision &&
			(app.draft.workflow?.publish as { kind?: string } | undefined)?.kind ===
				"dataset"
				? latestWorkflowRunInTransaction(
						db,
						scope,
						app.appId,
						app.workflowRevision,
						latest.inputs,
					)
				: null;
		const result = (previous?.result ?? latest?.result) as
			{ kind?: string; value?: unknown } | undefined;
		const binding = workflowScheduleInTransaction(db, scope, app.appId);
		const schedule = binding
			? scheduler.getInTransaction(db, binding.schedule_id)
			: null;
		return {
			status: {
				runId: latest?.runId,
				state: latest?.state,
				result: latest?.result,
				inputs: latest?.inputs,
				schedule,
			},
			data: result?.kind === "dataset" ? result.value : null,
		};
	};
}

function registerWorkflowProgressJob(
	deps: WorkflowDependencies,
	ports: { load: Load; fail: Fail; progress(db: Database, run: Run): void },
) {
	const { queue, scheduler, markdown, authority } = deps;
	const { load, fail, progress } = ports;
	const scope = deps.apps.scope;
	const now = deps.now ?? Date.now;
	queue.registerHandler({
		kind: jobKind,
		payloadVersions: [1],
		schema: jobInput,
		recovery: "replay_safe",
		prepareInTransaction(db, claim) {
			const run = load(db, claim.payload.runId);
			if (
				!run ||
				claim.payload.scope !== scope ||
				run.jobId !== claim.jobId ||
				!inProgress(run)
			)
				return { status: "stale", reason: "workflow_run_inactive" };
			let reconcile = false;
			if (
				run.state === "publishing" &&
				run.deadlineMs > now() &&
				authority.sourceInTransaction(db, scope, run.runId)
			) {
				markdown.generated.normalizeInterruptedInTransaction(db, run.runId);
				const receipt = markdown.generated.currentInTransaction(db, run.runId);
				const publication = publicationSchema.safeParse(run.publication);
				reconcile =
					receipt?.state === "settled" &&
					receipt.archive.state === "unknown" &&
					publication.success &&
					publication.data.checked !== 1;
			}
			return { status: "ready", input: { runId: run.runId, reconcile } };
		},
		async execute(input, { signal }) {
			if (input.reconcile) {
				await markdown.generated
					.reconcile(input.runId, signal)
					.catch(() => null);
				signal.throwIfAborted();
			}
			return input.reconcile;
		},
		settleInTransaction(db, claim, _input, outcome) {
			const run = load(db, claim.payload.runId);
			if (!run || run.jobId !== claim.jobId || !inProgress(run)) return "stale";
			if (outcome.type !== "success") {
				if (outcome.type === "retry" || outcome.type === "interrupted")
					return "applied";
				fail(db, run, "workflow_progress_failed");
				return "applied";
			}
			db.run("SAVEPOINT workflow_progress");
			try {
				if (outcome.result)
					markWorkflowPublicationCheckInTransaction(
						db,
						scope,
						run.runId,
						run.version,
						true,
					);
				progress(db, load(db, run.runId)!);
				db.run("RELEASE workflow_progress");
			} catch (error) {
				db.run("ROLLBACK TO workflow_progress");
				db.run("RELEASE workflow_progress");
				if (error instanceof Error && error.message === "queue_full")
					throw error;
				const code = toErrorCode(error, "workflow_progress_failed");
				getLogger("app-development").warn("workflow.progress_failed", {
					runId: run.runId,
					reason: code,
					status: run.state,
					...(error instanceof z.ZodError
						? {
								violations: error.issues
									.slice(0, 4)
									.map(({ path, code }) => path.join(".") + ":" + code)
									.join(" ")
									.slice(0, 256),
							}
						: {}),
				});
				fail(db, run, code);
			}
			return "applied";
		},
		cancelInTransaction(db, claim) {
			const run = load(db, claim.payload.runId);
			if (run?.jobId === claim.jobId && inProgress(run))
				fail(db, run, "workflow_cancelled", "cancelled");
		},
		afterCommit: () => {
			queue.wake();
			scheduler.wake();
		},
	});
}
