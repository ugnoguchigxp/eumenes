import type { Database } from "bun:sqlite";
import { z } from "zod";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import type { QueueService, HandlerDefinition } from "../../queue";
import type { ComputePort, RemoteJob, Result, SubmitInput } from "../contracts";
import { row, patch, type JobRow } from "../repository";

export type Step =
	| "submit"
	| "reconcile"
	| "poll"
	| "cancel"
	| "fetch"
	| "delete";
export type HandlerDeps = {
	store: SqliteStore;
	queue: QueueService;
	port: () => ComputePort | null;
	enqueue: (db: Database, id: string, step: Step, delay?: number) => void;
	notify: (db: Database, row: JobRow) => void;
	pollMs: number;
	validInTransaction?: (db: Database, row: JobRow) => boolean;
};
const safeCodes = new Set([
	"invalid_request",
	"limit_exceeded",
	"unauthorized",
	"not_found",
	"request_conflict",
	"artifact_not_ready",
	"job_expired",
	"queue_full",
	"unavailable",
	"compute_origin_mismatch",
	"compute_service_unavailable",
	"compute_invalid_response",
	"compute_identity_mismatch",
	"compute_invalid_artifact",
	"compute_connection_changed",
	"compute_submission_unconfirmed",
	"compute_stop_unconfirmed",
]);
export function failure(e: unknown) {
	const v = e as { code?: unknown; status?: unknown; retryAfterMs?: unknown };
	return {
		code:
			typeof v?.code === "string" && safeCodes.has(v.code)
				? v.code
				: "unavailable",
		status: typeof v?.status === "number" ? v.status : 0,
		delay:
			typeof v?.retryAfterMs === "number" && Number.isFinite(v.retryAfterMs)
				? Math.max(1000, v.retryAfterMs)
				: 3000,
	};
}
type Output =
	| { jobId: string }
	| { job: RemoteJob }
	| {
			artifacts: Array<{ id: string; content: Uint8Array }>;
			fetchError?: ReturnType<typeof failure>;
	  }
	| { deleted: true }
	| { error: ReturnType<typeof failure> }
	| { stale: true };
type Payload = { id: string; step: number; operation: Step };

/** One persisted step, with no network inside the writer and no blind submit retries. */
export function registerHandlers(deps: HandlerDeps) {
	const handler: HandlerDefinition<
		Payload,
		JobRow & { operation: Step },
		Output
	> = {
		kind: "compute.advance",
		payloadVersions: [1],
		schema: z.object({
			id: z.uuid(),
			step: z.number().int(),
			operation: z.enum([
				"submit",
				"reconcile",
				"poll",
				"cancel",
				"fetch",
				"delete",
			]),
		}),
		recovery: "replay_safe",
		prepareInTransaction(db, claim) {
			const r = row(db, claim.payload.id);
			if (!r || r.step !== claim.payload.step || r.state === "deleted")
				return { status: "stale", reason: "compute_state_changed" };
			let operation = claim.payload.operation;
			if (
				(operation === "poll" || operation === "cancel") &&
				(r.deadline <= Date.now() || deps.validInTransaction?.(db, r) === false)
			) {
				patch(db, r.id, {
					invalidated: 1,
					cancel_requested: 1,
					cancel_until: r.cancel_until ?? Date.now() + 30000,
				});
				operation = "cancel";
			}
			if (operation === "submit" && r.sent) {
				patch(db, r.id, {
					state: "indeterminate",
					error_code: "compute_submission_unconfirmed",
				});
				return { status: "stale", reason: "compute_submission_unconfirmed" };
			}
			return { status: "ready", input: { ...r, operation } };
		},
		async execute(input, { signal }) {
			try {
				const port = deps.port();
				if (!port || port.binding !== input.binding)
					return {
						error: { code: "compute_connection_changed", status: 0, delay: 0 },
					};
				const bounded = AbortSignal.any([signal, AbortSignal.timeout(15000)]);
				if (input.operation === "submit" || input.operation === "reconcile") {
					const allowed = await deps.store.write((db) => {
						const r = row(db, input.id);
						if (!r || r.step !== input.step || (r.cancel_requested && !r.sent))
							return false;
						if (
							r.deadline <= Date.now() ||
							deps.validInTransaction?.(db, r) === false
						) {
							patch(db, r.id, {
								invalidated: 1,
								cancel_requested: 1,
								state: r.sent ? "indeterminate" : "cancelled",
								error_code: "execution_expired",
							});
							return false;
						}
						patch(db, r.id, { sent: 1 });
						return true;
					});
					if (!allowed) return { stale: true };
					return {
						jobId: await port.submit(
							input.service_url,
							JSON.parse(input.body_json) as SubmitInput,
							input.idempotency_key,
							bounded,
						),
					};
				}
				if (!input.job_id)
					return {
						error: {
							code: "compute_submission_unconfirmed",
							status: 0,
							delay: 0,
						},
					};
				if (input.operation === "fetch") {
					const result = JSON.parse(input.result_json!) as Result;
					const saved = deps.store.read(
						(db) =>
							new Set(
								(
									db
										.query("SELECT id FROM compute_artifacts WHERE job_id=?")
										.all(input.id) as Array<{ id: string }>
								).map((a) => a.id),
							),
					);
					const artifacts = [];
					let fetchError: ReturnType<typeof failure> | undefined;
					for (const a of result.artifacts) {
						if (saved.has(a.id)) continue;
						try {
							artifacts.push({
								id: a.id,
								content: await port.artifact(
									input.service_url,
									input.job_id,
									a,
									bounded,
								),
							});
						} catch (e) {
							fetchError ??= failure(e);
						}
					}
					return { artifacts, fetchError };
				}
				if (input.operation === "delete") {
					const job = await port.delete(
						input.service_url,
						input.job_id,
						bounded,
					);
					return job ? { job } : { deleted: true };
				}
				return {
					job: await (input.operation === "cancel"
						? port.cancel(input.service_url, input.job_id, bounded)
						: port.get(input.service_url, input.job_id, bounded)),
				};
			} catch (e) {
				return { error: failure(e) };
			}
		},
		classify: () => "fail",
		settleInTransaction(db, claim, input, outcome) {
			const r = row(db, claim.payload.id);
			if (!r || r.step !== claim.payload.step) return "stale";
			const result: Output =
				outcome.type === "success"
					? outcome.result
					: { error: { code: "unavailable", status: 0, delay: 3000 } };
			if ("stale" in result) return "applied";
			if ("error" in result) {
				settleError(deps, db, r, claim.payload.operation, result.error);
				return "applied";
			}
			if ("jobId" in result) {
				patch(db, r.id, {
					job_id: result.jobId,
					state: "queued",
					stage: "queued",
					error_code: null,
					error_message: null,
				});
				deps.enqueue(
					db,
					r.id,
					r.cancel_requested ? "cancel" : "poll",
					r.cancel_requested ? 0 : deps.pollMs,
				);
			} else if ("artifacts" in result) {
				const manifest = (JSON.parse(r.result_json!) as Result).artifacts;
				for (const a of result.artifacts) {
					const meta = manifest.find((m) => m.id === a.id)!;
					db.query(
						"INSERT OR REPLACE INTO compute_artifacts VALUES(?,?,?,?,?,?)",
					).run(r.id, a.id, meta.name, meta.mime, meta.bytes, a.content);
				}
				if (result.fetchError)
					settleError(deps, db, r, "fetch", result.fetchError);
				else
					deps.notify(
						db,
						patch(db, r.id, { state: "completed", artifact_error: null }),
					);
			} else if ("deleted" in result) {
				db.query("DELETE FROM compute_artifacts WHERE job_id=?").run(r.id);
				patch(db, r.id, {
					state: "deleted",
					result_json: null,
					progress_json: null,
					error_message: null,
					delete_requested: 0,
				});
			} else {
				settleJob(deps, db, r, result.job, input?.operation === "cancel");
			}
			return "applied";
		},
		cancelInTransaction(db, job) {
			const r = row(db, job.payload.id);
			if (r) patch(db, r.id, { cancel_requested: 1, invalidated: 1 });
		},
	};
	deps.queue.registerHandler(handler);
}

function settleError(
	deps: HandlerDeps,
	db: Database,
	r: JobRow,
	step: Step,
	error: ReturnType<typeof failure>,
) {
	if (step === "submit" || step === "reconcile") {
		// An HTTP refusal is known; a broken connection or invalid receipt may have accepted the POST.
		const uncertain = error.status === 0 || error.status === 502;
		deps.notify(
			db,
			patch(db, r.id, {
				state: uncertain ? "indeterminate" : "failed",
				error_code: uncertain ? "compute_submission_unconfirmed" : error.code,
				error_message: null,
			}),
		);
		return;
	}
	if (step === "fetch") {
		if (
			[0, 429, 503].includes(error.status) &&
			error.code !== "compute_connection_changed" &&
			Date.now() < r.deadline
		) {
			deps.enqueue(
				db,
				r.id,
				"fetch",
				Math.min(error.delay, Math.max(0, r.deadline - Date.now())),
			);
			return;
		}
		deps.notify(
			db,
			patch(db, r.id, { state: "completed", artifact_error: error.code }),
		);
		return;
	}
	if (step === "delete") {
		patch(db, r.id, { delete_requested: 0, error_code: error.code });
		return;
	}
	if (
		[0, 429, 503].includes(error.status) &&
		error.code !== "compute_connection_changed" &&
		Date.now() < (r.cancel_until ?? r.deadline)
	) {
		deps.enqueue(
			db,
			r.id,
			step,
			Math.min(
				error.delay,
				Math.max(0, (r.cancel_until ?? r.deadline) - Date.now()),
			),
		);
		return;
	}
	deps.notify(
		db,
		patch(db, r.id, {
			state: "indeterminate",
			error_code: r.cancel_requested ? "compute_stop_unconfirmed" : error.code,
			error_message: null,
		}),
	);
}

function settleJob(
	deps: HandlerDeps,
	db: Database,
	r: JobRow,
	job: RemoteJob,
	wasCancel: boolean,
) {
	const expired =
		Date.now() >= r.deadline || deps.validInTransaction?.(db, r) === false;
	patch(db, r.id, {
		stage: job.stage,
		progress_json: job.progress ? JSON.stringify(job.progress) : null,
		expires_at: job.expiresAt,
		...(expired ? { invalidated: 1 } : {}),
		error_code: job.error?.code ?? null,
		error_message: job.error?.message ?? null,
	});
	if (job.status === "queued" || job.status === "running") {
		const needsCancel = !!r.cancel_requested || expired;
		if (needsCancel && Date.now() >= (r.cancel_until ?? r.deadline + 30000)) {
			deps.notify(
				db,
				patch(db, r.id, {
					state: "indeterminate",
					error_code: "compute_stop_unconfirmed",
				}),
			);
			return;
		}
		patch(db, r.id, {
			state: job.status,
			cancel_requested: needsCancel ? 1 : 0,
			...(needsCancel && !r.cancel_until
				? { cancel_until: Date.now() + 30000 }
				: {}),
		});
		deps.enqueue(
			db,
			r.id,
			needsCancel && !wasCancel && !job.cancelRequested ? "cancel" : "poll",
			deps.pollMs,
		);
		return;
	}
	if (job.status === "completed" && !job.result) {
		deps.notify(
			db,
			patch(db, r.id, {
				state: "failed",
				error_code: "compute_invalid_response",
			}),
		);
		return;
	}
	const needsFetch =
		job.status === "completed" && !!job.result?.artifacts.length;
	const updated = patch(db, r.id, {
		state: needsFetch ? "collecting" : job.status,
		result_json: job.result ? JSON.stringify(job.result) : null,
	});
	if (r.delete_requested) deps.enqueue(db, r.id, "delete", deps.pollMs);
	else if (needsFetch) deps.enqueue(db, r.id, "fetch");
	else deps.notify(db, updated);
}
