import type { Database } from "bun:sqlite";
import type { HostState, SourcePort } from "../contracts";
import type { TaskLifecyclePort } from "../../tool-runtime";
import { getLogger } from "../../../infrastructure/logger";
import { current, type Context, type PursuitDeps } from "./context";
import { active, rowOf, save, stateOf, type RunRow } from "../repository";
import { controls } from "./control";
import { registerJobs } from "./jobs";
import { end, forget, notice, reconcile } from "./lifecycle";
import { collectWeb } from "./web";
import { reportInTransaction, viewInTransaction } from "./view";

const log = getLogger("pursuit");
export function createPursuit(deps: PursuitDeps) {
	let source: SourcePort | undefined,
		timer: ReturnType<typeof setInterval> | undefined;
	let unsubscribe: (() => void) | undefined,
		closed = false,
		pending: Promise<void> | undefined;
	const ctx: Context = {
		...deps,
		now: deps.now ?? Date.now,
		id: deps.id ?? (() => crypto.randomUUID()),
		abortJobs: new Set(),
		abortRequests: new Set(),
		source() {
			if (!source) throw new Error("pursuit_not_configured");
			return source;
		},
		enqueue(db, row) {
			row.step++;
			const job = deps.queue.enqueueInTransaction(db, {
				scope: "pursuit",
				kind: "pursuit.step",
				dedupeKey: `${row.id}:${row.epoch}:${row.step}`,
				subjectRef: row.id,
				concurrencyKey: `pursuit:${row.id}`,
				lane: "background",
				deadlineAtMs: row.deadline,
				payload: { id: row.id, epoch: row.epoch, step: row.step },
				maxAttempts: 1,
			});
			row.job_id = job.job.id;
		},
		forget: (db, id) => forget(ctx, db, id),
		notice: (db, row) => notice(ctx, db, row),
	};
	registerJobs(ctx);
	function flush() {
		deps.queue.flushCancellations([...ctx.abortJobs]);
		ctx.abortJobs.clear();
		deps.inference.flushCancelledRequests?.([...ctx.abortRequests]);
		ctx.abortRequests.clear();
		deps.web.flush();
		deps.queue.wake();
	}
	async function maintain(recovering = false) {
		if (closed || !source) return;
		if (pending) return pending;
		pending = deps.store
			.write((db) => {
				reconcile(ctx, db, recovering);
				collectWeb(ctx, db);
			})
			.then(flush)
			.finally(() => {
				pending = undefined;
			});
		return pending;
	}
	const task: TaskLifecyclePort = {
		startInTransaction(db, input) {
			if (
				closed ||
				!source ||
				!input.toolchainRevisionId ||
				!input.bindingRevisionId
			)
				throw new Error("pursuit_unavailable");
			if (
				!source.validSourceInTransaction(db, input.source) ||
				input.references.some(
					(ref) => !source!.validReferenceInTransaction(db, input.source, ref),
				)
			)
				throw new Error("pursuit_source_invalid");
			const set = deps.capabilities.toolchainSetInTransaction(
					db,
					input.toolchainRevisionId,
				),
				binding = set.binding?.document;
			if (
				set.binding?.revisionId !== input.bindingRevisionId ||
				binding?.execution !== "task" ||
				binding.adapterRef !== "adapter:pursuit@1"
			)
				throw new Error("pursuit_binding_invalid");
			const request = input.request.trim();
			if (!request || request.length > 8000 || input.references.length > 32)
				throw new Error("pursuit_request_invalid");
			const id = ctx.id(),
				now = ctx.now();
			const prepared = deps.capabilities.prepareActiveByIdInTransaction(
				db,
				{ taskId: id, rootRunId: input.source.runId, cancelEpoch: 0 },
				set.package.revisionId,
				{},
			);
			const state: HostState = {
				source: input.source,
				request,
				references: input.references,
				prepared,
				toolchainRevisionId: input.toolchainRevisionId,
				bindingRevisionId: input.bindingRevisionId,
				instructions: [set.profile, ...set.skills].join("\n"),
				limits: binding.limits,
				inferenceMs: binding.timeLimits.inferenceMs,
				coreIds: [],
				modelCalls: 0,
				webCalls: 0,
				searches: 0,
				draft: null,
				snapshots: {},
				result: null,
			};
			const row: RunRow = {
				id,
				conversation_id: input.source.conversationId,
				state: "queued",
				epoch: 0,
				revision: 0,
				deadline: now + binding.timeLimits.runMs,
				step: 0,
				core_id: null,
				data_json: JSON.stringify(state),
				job_id: null,
				active_request: null,
				created_at: now,
				updated_at: now,
			};
			db.query(
				"INSERT INTO pursuit_runs(id,conversation_id,state,epoch,revision,deadline,step,data_json,created_at,updated_at) VALUES (?,?,'queued',0,0,?,0,?,?,?)",
			).run(id, row.conversation_id, row.deadline, row.data_json, now, now);
			ctx.enqueue(db, row);
			save(db, row, state, now);
			return viewInTransaction(db, id)!;
		},
		controlInTransaction: controls(ctx),
		viewInTransaction(db, id) {
			try {
				current(ctx, db, id, undefined, true);
				return viewInTransaction(db, id);
			} catch {
				return null;
			}
		},
		cancelInTransaction(db, conversationId, id) {
			const row = rowOf(db, id);
			if (
				row?.data_json &&
				row.conversation_id === conversationId &&
				active(row)
			)
				end(ctx, db, row, "cancelled", "pursuit_user_cancelled");
		},
		forgetInTransaction: ctx.forget,
	};
	return {
		task,
		reportInTransaction,
		configure(port: SourcePort) {
			source = port;
		},
		availableInTransaction: () =>
			!closed &&
			source !== undefined &&
			typeof deps.inference.executeControl === "function" &&
			typeof deps.inference.usageOfInTransaction === "function",
		sourceRunInTransaction(db: Database, id: string) {
			try {
				return stateOf(current(ctx, db, id, undefined, true)).source.runId;
			} catch {
				return null;
			}
		},
		flush,
		maintain,
		recover: () => maintain(true),
		start() {
			if (closed || timer) return;
			const wake = () => {
				void maintain().catch((error) =>
					log.warn(
						"pursuit.maintenance_failed",
						{ reason: "maintenance_failed" },
						error,
					),
				);
			};
			unsubscribe = deps.store.onCommit(wake);
			timer = setInterval(wake, 1000);
			timer.unref();
			wake();
		},
		async close() {
			closed = true;
			unsubscribe?.();
			if (timer) clearInterval(timer);
			await pending;
			flush();
		},
	};
}
export type PursuitService = ReturnType<typeof createPursuit>;
