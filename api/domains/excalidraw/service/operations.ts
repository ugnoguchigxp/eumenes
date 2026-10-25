import { executionCallSession } from "../../tool-runtime";
import { z } from "zod";
import type { Database } from "bun:sqlite";
import { parseLlmJson } from "../../../infrastructure/llm-json";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import {
	drawingRequest,
	drawingPlan,
	type Capabilities,
	type Prepared,
} from "../../capabilities";
import {
	delegatedTaskRules,
	type InferencePort,
	type Receipt,
} from "../../inference";
import type { QueueService, HandlerDefinition } from "../../queue";
import { references } from "../repository";
import type { ExcalidrawService } from "./index";
import type { ChildExecution } from "../../tool-runtime";
type RecordValue = {
	id: string;
	runId: string;
	conversationId: string;
	state: "planning" | "starting" | "completed" | "failed" | "cancelled";
	sessionId: string | null;
	referenceId: string | null;
	url: string | null;
	action: string | null;
	errorCode: string | null;
	title: string;
};
type Row = {
	id: string;
	run_id: string;
	conversation_id: string;
	record_json: string;
	request_json: string;
	bindings_json: string;
	deadline: number;
	job_id: string | null;
};
const read = (db: Database, id: string) =>
	db
		.query("SELECT * FROM excalidraw_operations WHERE id=?")
		.get(id) as Row | null;
const view = (r: Row): RecordValue => JSON.parse(r.record_json);
function patch(db: Database, r: Row, change: Partial<RecordValue>) {
	db.query("UPDATE excalidraw_operations SET record_json=? WHERE id=?").run(
		JSON.stringify({ ...view(r), ...change }),
		r.id,
	);
}
export function registerDrawingOperations(deps: {
	store: SqliteStore;
	queue: QueueService;
	inference: InferencePort;
	capabilities: Capabilities;
	service: ExcalidrawService;
	onJob: (db: Database, runId: string, jobId: string) => void;
	onFinished: (db: Database, runId: string) => void;
	validateExecutionInTransaction?: (
		db: Database,
		child: ChildExecution,
	) => boolean;
}) {
	const { queue, inference, capabilities, service } = deps;
	function enqueue(db: Database, r: Row, stage: "plan" | "open") {
		const { job } = queue.enqueueInTransaction(db, {
			scope: "excalidraw",
			kind: `excalidraw.${stage}`,
			dedupeKey: `${r.id}:${stage}`,
			payload: { id: r.id },
			subjectRef: r.id,
			lane: "interactive",
			resourceKey: stage === "plan" ? "inference.llm" : "excalidraw.connect",
			maxAttempts: 1,
			deadlineAtMs: r.deadline - 15000,
		});
		db.query("UPDATE excalidraw_operations SET job_id=? WHERE id=?").run(
			job.id,
			r.id,
		);
		if (!JSON.parse(r.request_json).execution) deps.onJob(db, r.run_id, job.id);
		return job.id;
	}
	const fail = (db: Database, r: Row, code: string) => {
		patch(db, r, { state: "failed", errorCode: code });
		if (!JSON.parse(r.request_json).execution) deps.onFinished(db, r.run_id);
	};
	const cancel = (db: Database, job: { payload: { id: string } }) => {
		const r = read(db, job.payload.id);
		if (r) patch(db, r, { state: "cancelled", errorCode: "cancel_requested" });
	};
	type PlanInput = {
		row: Row;
		prepared: Prepared;
		requestId: string;
		messages: Array<{ role: "system" | "user"; content: string }>;
		control: { instructions: string; outputSchema: unknown };
	};
	const handler: HandlerDefinition<
		{ id: string },
		PlanInput,
		{ receipt: Receipt; plan: z.infer<typeof drawingPlan> }
	> = {
		kind: "excalidraw.plan",
		payloadVersions: [1],
		schema: z.object({ id: z.string() }),
		recovery: "interrupt",
		resourceKey: "inference.llm",
		prepareInTransaction(db, claim) {
			const r = read(db, claim.payload.id);
			if (!r || view(r).state !== "planning")
				return { status: "stale", reason: "drawing_not_planning" };
			if (!inference.captureControlInTransaction || !inference.executeControl)
				throw new Error("excalidraw_inference_unavailable");
			const prepared = JSON.parse(r.bindings_json) as Prepared;
			capabilities.validateInTransaction(db, prepared);
			const ids = [
				prepared.package.profileRevisionId,
				...(prepared.package.requiredSkillRevisionIds ?? []),
			];
			const outputSchema = z.toJSONSchema(drawingPlan);
			const instructions =
				ids
					.map(
						(id) =>
							prepared.dependencies.find((d) => d.revisionId === id)?.body,
					)
					.join("\n\n") +
				`\n${delegatedTaskRules}` +
				"\nTOOLS=" +
				JSON.stringify(
					prepared.dependencies
						.filter((d) => d.kind === "tool")
						.map((d) => ({ id: d.id, summary: d.summary })),
				) +
				"\nOUTPUT_SCHEMA=" +
				JSON.stringify(outputSchema);
			const control = { instructions, outputSchema };
			const execution = JSON.parse(r.request_json).execution;
			if (execution && !deps.validateExecutionInTransaction?.(db, execution))
				throw new Error("execution_changed");
			const capture = {
				subject: `excalidraw:${r.id}:plan`,
				policySubject: r.run_id,
				deadline: Math.min(r.deadline - 15000, Date.now() + 45000),
				maxOutputTokens: 2048,
			};
			const requestId = execution
				? inference.captureUserControlInTransaction!(db, {
						...capture,
						subject: `drawing-task:${r.id}-plan`,
					})
				: inference.captureControlInTransaction(db, capture);
			return {
				status: "ready",
				input: {
					row: r,
					prepared,
					requestId,
					control,
					messages: [
						{ role: "system", content: instructions },
						{
							role: "user",
							content: JSON.stringify({
								...JSON.parse(r.request_json),
								references: references(db, r.conversation_id),
							}),
						},
					],
				},
			};
		},
		async execute(input, { signal }) {
			const receipt = await inference.executeControl!(
				input.requestId,
				input.messages,
				signal,
				input.control,
				JSON.parse(input.row.request_json).execution
					? executionCallSession(JSON.parse(input.row.request_json).execution)
					: undefined,
			);
			return { receipt, plan: drawingPlan.parse(parseLlmJson(receipt.value)) };
		},
		classify: () => "fail",
		settleInTransaction(db, claim, input, outcome) {
			const r = read(db, claim.payload.id);
			if (!r || view(r).state !== "planning") return "stale";
			if (!input || outcome.type !== "success") {
				fail(db, r, "excalidraw_plan_failed");
				return "applied";
			}
			capabilities.validateInTransaction(db, input.prepared);
			if (!inference.acceptInTransaction?.(db, outcome.result.receipt)) {
				fail(db, r, "excalidraw_plan_invalidated");
				return "applied";
			}
			const plan = outcome.result.plan;
			if (
				plan.action === "open" &&
				!references(db, r.conversation_id).some(
					(ref) => ref.id === plan.referenceId,
				)
			) {
				fail(db, r, "excalidraw_reference_not_found");
				return "applied";
			}
			// A new drawing is an unsaved local editor; LARM is reached only by its first save.
			const opens = plan.action === "open";
			patch(db, r, {
				state: opens ? "starting" : "completed",
				referenceId: opens ? plan.referenceId : null,
				title: plan.title,
				action: plan.action,
				...(plan.action === "create"
					? { url: service.draftUrl(r.conversation_id, plan.title) }
					: {}),
			});
			// A plan is not an external success. The second job starts after the accepted receipt commits.
			db.query(
				"UPDATE excalidraw_operations SET request_json=? WHERE id=?",
			).run(JSON.stringify({ ...JSON.parse(r.request_json), ...plan }), r.id);
			if (opens) enqueue(db, r, "open");
			else if (!JSON.parse(r.request_json).execution)
				deps.onFinished(db, r.run_id);
			return "applied";
		},
		cancelInTransaction: cancel,
	};
	const opener: HandlerDefinition<
		{ id: string },
		Row,
		Awaited<ReturnType<ExcalidrawService["wait"]>>
	> = {
		kind: "excalidraw.open",
		payloadVersions: [1],
		schema: z.object({ id: z.string() }),
		recovery: "interrupt",
		resourceKey: "excalidraw.connect",
		prepareInTransaction(db, claim) {
			const r = read(db, claim.payload.id);
			if (!r || view(r).state !== "starting")
				return { status: "stale", reason: "drawing_not_starting" };
			capabilities.validateInTransaction(db, JSON.parse(r.bindings_json));
			return { status: "ready", input: r };
		},
		async execute(r, { signal }) {
			const raw = JSON.parse(r.request_json);
			const plan = drawingPlan.parse(
				Object.fromEntries(
					Object.keys(drawingPlan.shape)
						.filter((key) => key in raw)
						.map((key) => [key, raw[key]]),
				),
			);
			const s = await service.session({
				requestId: r.id,
				conversationId: r.conversation_id,
				title: plan.title,
				referenceId: plan.referenceId!,
				...(plan.revision ? { revision: plan.revision } : {}),
			});
			const abort = () => {
				void service.release(s.id);
			};
			signal.addEventListener("abort", abort, { once: true });
			try {
				if (signal.aborted) {
					await service.release(s.id);
					signal.throwIfAborted();
				}
				return await service.wait(s.id);
			} finally {
				signal.removeEventListener("abort", abort);
			}
		},
		classify: () => "fail",
		settleInTransaction(db, claim, input, outcome) {
			const r = read(db, claim.payload.id);
			if (!r || view(r).state !== "starting") return "stale";
			if (
				!input ||
				outcome.type !== "success" ||
				outcome.result?.state !== "ready"
			) {
				fail(db, r, "excalidraw_start_failed");
				return "applied";
			}
			try {
				capabilities.validateInTransaction(db, JSON.parse(r.bindings_json));
			} catch {
				fail(db, r, "capability_revoked");
				return "applied";
			}
			const s = outcome.result;
			patch(db, r, {
				state: "completed",
				sessionId: s.id,
				referenceId: s.referenceId,
				url: s.url,
				title: s.title,
			});
			if (!JSON.parse(r.request_json).execution) deps.onFinished(db, r.run_id);
			return "applied";
		},
		cancelInTransaction: cancel,
	};
	queue.registerHandler(handler);
	queue.registerHandler(opener);
	return drawingOperations(deps, enqueue, cancel);
}

function drawingOperations(
	deps: Parameters<typeof registerDrawingOperations>[0],
	enqueue: (db: Database, r: Row, stage: "plan" | "open") => string,
	cancel: (db: Database, job: { payload: { id: string } }) => void,
) {
	const { store, capabilities, queue } = deps;
	return {
		startInTransaction(
			db: Database,
			input: {
				runId: string;
				conversationId: string;
				question: string;
				originalRequest: string;
				deadline: number;
				execution?: ChildExecution;
			},
		) {
			const existing = input.execution
				? read(db, input.execution.id)
				: (db
						.query(
							"SELECT * FROM excalidraw_operations WHERE run_id=? AND json_extract(request_json,'$.execution') IS NULL",
						)
						.get(input.runId) as Row | null);
			if (existing) return { id: existing.id, jobId: existing.job_id! };
			if (
				input.execution &&
				!deps.validateExecutionInTransaction?.(db, input.execution)
			)
				throw new Error("execution_changed");
			const id = input.execution?.id ?? crypto.randomUUID(),
				request = drawingRequest.parse({ question: input.question });
			const prepared = capabilities.prepareActiveByIdInTransaction(
				db,
				{ rootRunId: input.runId, taskId: id, cancelEpoch: 0 },
				"package:excalidraw.edit@1",
				request,
			);
			const record: RecordValue = {
				id,
				runId: input.runId,
				conversationId: input.conversationId,
				state: "planning",
				sessionId: null,
				referenceId: null,
				action: null,
				title: "図の編集",
				url: null,
				errorCode: null,
			};
			db.query("INSERT INTO excalidraw_operations VALUES(?,?,?,?,?,?,?,?)").run(
				id,
				input.runId,
				input.conversationId,
				JSON.stringify(record),
				JSON.stringify({
					...request,
					originalRequest: input.originalRequest,
					...(input.execution
						? { execution: input.execution, references: input.execution.refs }
						: {}),
				}),
				JSON.stringify(prepared),
				input.deadline,
				null,
			);
			return { id, jobId: enqueue(db, read(db, id)!, "plan") };
		},
		resultInTransaction(db: Database, runId: string) {
			const r = db
				.query(
					"SELECT * FROM excalidraw_operations WHERE run_id=? AND json_extract(request_json,'$.execution') IS NULL",
				)
				.get(runId) as Row | null;
			return r ? view(r) : null;
		},
		purgeCallInTransaction(db: Database, id: string) {
			db.query(
				"UPDATE excalidraw_operations SET request_json=json_object('execution',json_object('id',id,'erased',1)) WHERE id=? AND json_extract(request_json,'$.execution') IS NOT NULL",
			).run(id);
		},
		resultForCallInTransaction(db: Database, id: string) {
			const r = read(db, id);
			return r ? view(r) : null;
		},
		cancelCallInTransaction(db: Database, id: string) {
			const r = read(db, id);
			if (r?.job_id && ["planning", "starting"].includes(view(r).state)) {
				cancel(db, { payload: { id } });
				queue.cancelInTransaction(db, r.job_id, "execution_cancelled");
			}
		},
		list: (conversationId: string) =>
			store.read((db) =>
				(
					db
						.query(
							"SELECT * FROM excalidraw_operations WHERE conversation_id=? ORDER BY rowid DESC LIMIT 100",
						)
						.all(conversationId) as Row[]
				).map(view),
			),
	};
}
