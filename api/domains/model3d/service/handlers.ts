import { z } from "zod";
import type { Database } from "bun:sqlite";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import type { HandlerDefinition, QueueService } from "../../queue";
import {
	isLarmRefusal,
	type Model3dAsset,
	type Model3dLarm,
	type Model3dSource,
} from "../contracts";
import {
	forgetAsset,
	generationRow,
	generationView,
	operationRow,
	patchGeneration,
	rememberAssets,
	settleOperation,
	type GenerationRow,
} from "../repository";

export type Stage = "submit" | "poll" | "cancel";
export type Deps = {
	store: SqliteStore;
	queue: QueueService;
	larm: () => Model3dLarm | null;
	enqueue: (db: Database, id: string, stage: Stage, delay?: number) => void;
	notify: (
		db: Database,
		r: GenerationRow,
		kind: "completed" | "failed",
	) => void;
	notifyOperation: (db: Database, id: string) => void;
	cancelUnconfirmed: (db: Database, r: GenerationRow) => void;
	pollMs: number;
	/** Pause after a busy or unreachable LARM that gave no Retry-After. */
	waitMs: number;
};
type Body = Parameters<Model3dLarm["submit"]>[1];

/** LARM refusals that end the attempt with a code the user can act on; the rest are retried. */
function refusalCode(e: unknown) {
	if (!isLarmRefusal(e)) return null;
	if (e.status === 400 || e.status === 422) return "model3d_invalid_request";
	if (e.status === 401 || e.status === 403) return "model3d_auth_failed";
	if (e.status === 404) return "model3d_not_found";
	if (e.status === 409) return "model3d_idempotency_conflict";
	if (e.status === 503) return "model3d_unavailable";
	if (e.status === 507) return "model3d_storage_full";
	return null;
}
const failsOnce = (e: unknown) =>
	e instanceof Error && /^model3d_[a-z_]+$/.test(e.message) ? "fail" : "retry";
function larmOf(deps: Deps) {
	const larm = deps.larm();
	if (!larm) throw new Error("model3d_larm_unconfigured");
	return larm;
}
/** One LARM call never holds the 3D queue longer than this. */
const CALL_MS = 60_000;
const bounded = (signal: AbortSignal) =>
	AbortSignal.any([signal, AbortSignal.timeout(CALL_MS)]);
/** A 429 waits for Retry-After; any other refusal becomes a model3d code. */
async function guarded<T>(work: () => Promise<T>, waitMs: number) {
	try {
		return { ok: true as const, value: await work() };
	} catch (e) {
		if (isLarmRefusal(e) && e.status === 429)
			return { ok: false as const, waitMs: e.retryAfterMs ?? waitMs };
		if (e instanceof Error && e.message === "invalid_mesh_service")
			throw new Error("model3d_service_invalid");
		const code = refusalCode(e);
		throw code ? new Error(code) : e;
	}
}
/**
 * Following a job tolerates a busy or restarting LARM until the deadline: only a refused credential
 * or an unknown job ends it.
 */
async function patient<T>(
	work: () => Promise<T>,
	signal: AbortSignal,
	waitMs: number,
) {
	try {
		return { ok: true as const, value: await work() };
	} catch (e) {
		if (signal.aborted) throw e;
		if (isLarmRefusal(e) && [401, 403, 404].includes(e.status))
			throw new Error(refusalCode(e)!);
		return {
			ok: false as const,
			waitMs: (isLarmRefusal(e) && e.retryAfterMs) || waitMs,
		};
	}
}
function failureCode(job: Awaited<ReturnType<Model3dLarm["job"]>>) {
	const reason = job.errorCode ?? job.error ?? job.reason ?? "";
	if (reason === "interrupted") return "model3d_interrupted";
	if (reason === "worker_stop_failed") return "model3d_worker_stop_failed";
	return "model3d_generation_failed";
}

export function registerModel3dHandlers(deps: Deps) {
	registerSubmit(deps);
	registerPoll(deps);
	registerCancel(deps);
	registerOperation(deps);
}

function registerSubmit(deps: Deps) {
	type Input = {
		id: string;
		key: string;
		body: Body | null;
		path: string | null;
		source: Model3dSource;
		title: string;
		tags: string[];
		seed: number;
	};
	type Output = { jobId: string } | { waitMs: number };
	const handler: HandlerDefinition<
		{ id: string; step: number },
		Input,
		Output
	> = {
		kind: "model3d.submit",
		payloadVersions: [1],
		schema: z.object({ id: z.uuid(), step: z.number().int() }),
		recovery: "replay_safe",
		resourceKey: "model3d",
		prepareInTransaction(db, claim) {
			const r = generationRow(db, claim.payload.id);
			// After a cancel the fixed body is resent only to learn (and then cancel) the job LARM may hold.
			const resend = r?.state === "cancelled" && !r.job_id && !!r.request_json;
			if (
				!r ||
				r.step !== claim.payload.step ||
				(r.state !== "submitting" && !resend)
			)
				return { status: "stale", reason: "model3d_state_changed" };
			return {
				status: "ready",
				input: {
					id: r.id,
					key: r.idempotency_key,
					body: r.request_json ? JSON.parse(r.request_json) : null,
					path: r.service_path,
					source: JSON.parse(r.source_json),
					title: r.title,
					tags: JSON.parse(r.tags_json),
					seed: r.seed,
				},
			};
		},
		async execute(input, { signal }) {
			const larm = larmOf(deps);
			let { body, path } = input;
			if (!body || !path) {
				// The body is fixed once and resent unchanged with the same key.
				const discovered = await guarded(
					() => larm.discover(bounded(signal)),
					deps.waitMs,
				);
				if (!discovered.ok) return { waitMs: discovered.waitMs };
				const found = discovered.value;
				if (!found.mesh) throw new Error("model3d_service_unavailable");
				if (input.source.type === "prompt" && !found.image)
					throw new Error("model3d_image_service_unavailable");
				const built: Body = {
					model: found.mesh.model,
					source:
						input.source.type === "prompt"
							? {
									type: "prompt",
									prompt: input.source.prompt,
									imageModel: found.image!.model,
								}
							: input.source,
					title: input.title,
					tags: input.tags,
					resolution: 512,
					seed: input.seed,
				};
				const fixed = await deps.store.write((db) => {
					const r = generationRow(db, input.id);
					if (!r || r.state !== "submitting") return null;
					if (r.request_json && r.service_path)
						return {
							body: JSON.parse(r.request_json) as Body,
							path: r.service_path,
						};
					patchGeneration(db, r.id, {
						request_json: JSON.stringify(built),
						service_path: found.mesh!.path,
					});
					return { body: built, path: found.mesh!.path };
				});
				if (!fixed) throw new Error("model3d_state_changed");
				({ body, path } = fixed);
			}
			const sent = await guarded(
				() => larm.submit(path!, body!, input.key, bounded(signal)),
				deps.waitMs,
			);
			return sent.ok ? { jobId: sent.value } : { waitMs: sent.waitMs };
		},
		classify: failsOnce,
		settleInTransaction(db, claim, _input, outcome) {
			const r = generationRow(db, claim.payload.id);
			if (!r || r.step !== claim.payload.step) return "stale";
			if (outcome.type === "retry") return "applied";
			if (outcome.type === "success" && "jobId" in outcome.result) {
				if (r.state === "cancelled") {
					// Cancelled while the POST was in flight: cancel the job LARM accepted.
					patchGeneration(db, r.id, { job_id: outcome.result.jobId });
					deps.enqueue(db, r.id, "cancel");
					return "applied";
				}
				if (r.state !== "submitting") return "stale";
				patchGeneration(db, r.id, {
					job_id: outcome.result.jobId,
					state: "queued",
					stage: "queued",
				});
				deps.enqueue(db, r.id, "poll", deps.pollMs);
				return "applied";
			}
			if (outcome.type === "success" && "waitMs" in outcome.result) {
				if (Date.now() < r.deadline) {
					deps.enqueue(db, r.id, "submit", outcome.result.waitMs);
					return "applied";
				}
				if (r.state !== "submitting") return "stale";
				deps.notify(
					db,
					patchGeneration(db, r.id, {
						state: "failed",
						error_code: "model3d_timeout",
					}),
					"failed",
				);
				return "applied";
			}
			if (r.state !== "submitting") return "stale";
			const code =
				"errorCode" in outcome && /^model3d_[a-z_]+$/.test(outcome.errorCode)
					? outcome.errorCode
					: "model3d_submission_unconfirmed";
			deps.notify(
				db,
				patchGeneration(db, r.id, { state: "failed", error_code: code }),
				"failed",
			);
			return "applied";
		},
		cancelInTransaction(db, job) {
			const r = generationRow(db, job.payload.id);
			if (r?.state === "submitting")
				patchGeneration(db, r.id, {
					state: "failed",
					error_code: "model3d_submission_unconfirmed",
				});
		},
	};
	deps.queue.registerHandler(handler);
}

function registerPoll(deps: Deps) {
	type Input = { id: string; path: string; jobId: string };
	type Output =
		| {
				job: Awaited<ReturnType<Model3dLarm["job"]>>;
				asset: Model3dAsset | null;
		  }
		| { waitMs: number };
	const handler: HandlerDefinition<
		{ id: string; step: number },
		Input,
		Output
	> = {
		kind: "model3d.poll",
		payloadVersions: [1],
		schema: z.object({ id: z.uuid(), step: z.number().int() }),
		recovery: "replay_safe",
		resourceKey: "model3d",
		prepareInTransaction(db, claim) {
			const r = generationRow(db, claim.payload.id);
			if (
				!r ||
				r.step !== claim.payload.step ||
				!["queued", "running"].includes(r.state) ||
				!r.job_id ||
				!r.service_path
			)
				return { status: "stale", reason: "model3d_state_changed" };
			return {
				status: "ready",
				input: { id: r.id, path: r.service_path, jobId: r.job_id },
			};
		},
		async execute(input, { signal }) {
			const larm = larmOf(deps);
			const read = await patient(
				() => larm.job(input.path, input.jobId, bounded(signal)),
				signal,
				deps.waitMs,
			);
			if (!read.ok) return { waitMs: read.waitMs };
			const job = read.value;
			const assetId = job.assetId ?? job.asset?.id ?? null;
			let asset: Model3dAsset | null = null;
			if (job.status === "completed" && !job.deleted && assetId)
				// The index entry is best effort; the generation completes without it.
				asset = await larm.asset(assetId, bounded(signal)).catch(() => null);
			return { job, asset };
		},
		classify: failsOnce,
		settleInTransaction(db, claim, _input, outcome) {
			const r = generationRow(db, claim.payload.id);
			if (
				!r ||
				r.step !== claim.payload.step ||
				!["queued", "running"].includes(r.state)
			)
				return "stale";
			if (outcome.type === "retry") return "applied";
			if (outcome.type !== "success") {
				const code =
					"errorCode" in outcome && /^model3d_[a-z_]+$/.test(outcome.errorCode)
						? outcome.errorCode
						: "model3d_status_unconfirmed";
				deps.notify(
					db,
					patchGeneration(db, r.id, { state: "failed", error_code: code }),
					"failed",
				);
				return "applied";
			}
			if ("waitMs" in outcome.result && Date.now() < r.deadline) {
				deps.enqueue(db, r.id, "poll", outcome.result.waitMs);
				return "applied";
			}
			if ("waitMs" in outcome.result) {
				deps.notify(
					db,
					patchGeneration(db, r.id, {
						state: "failed",
						error_code: "model3d_timeout",
					}),
					"failed",
				);
				return "applied";
			}
			const { job, asset } = outcome.result;
			const stage = job.stage ?? job.status;
			if (job.status === "queued" || job.status === "running") {
				if (Date.now() >= r.deadline) {
					deps.notify(
						db,
						patchGeneration(db, r.id, {
							state: "failed",
							stage,
							error_code: "model3d_timeout",
						}),
						"failed",
					);
					return "applied";
				}
				patchGeneration(db, r.id, { state: job.status, stage });
				deps.enqueue(db, r.id, "poll", deps.pollMs);
				return "applied";
			}
			if (job.status === "cancelled") {
				patchGeneration(db, r.id, { state: "cancelled", stage });
				return "applied";
			}
			if (job.status === "failed") {
				deps.notify(
					db,
					patchGeneration(db, r.id, {
						state: "failed",
						stage,
						error_code: failureCode(job),
					}),
					"failed",
				);
				return "applied";
			}
			const assetId = job.assetId ?? job.asset?.id ?? null;
			if (!assetId && !job.deleted) {
				deps.notify(
					db,
					patchGeneration(db, r.id, {
						state: "failed",
						stage,
						error_code: "model3d_asset_missing",
					}),
					"failed",
				);
				return "applied";
			}
			const warnings =
				job.warnings ?? job.asset?.warnings ?? asset?.warnings ?? [];
			const done = patchGeneration(db, r.id, {
				state: "completed",
				stage: job.deleted ? "deleted" : "completed",
				asset_id: assetId,
				deleted: job.deleted ? 1 : 0,
				warnings_json: JSON.stringify(warnings.slice(0, 16)),
			});
			if (assetId && !job.deleted) {
				const v = generationView(done);
				rememberAssets(db, r.owner, [
					asset ?? {
						id: assetId,
						title: v.title,
						tags: v.tags,
						createdAt: new Date(r.created_at).toISOString(),
						prompt: v.source.type === "prompt" ? v.source.prompt : null,
						warnings,
						hasSource: true,
					},
				]);
			}
			deps.notify(db, done, "completed");
			return "applied";
		},
		cancelInTransaction(db, job) {
			const r = generationRow(db, job.payload.id);
			if (r && ["queued", "running"].includes(r.state))
				patchGeneration(db, r.id, {
					state: "failed",
					error_code: "model3d_status_unconfirmed",
				});
		},
	};
	deps.queue.registerHandler(handler);
}

function registerCancel(deps: Deps) {
	type Input = { path: string; jobId: string };
	const handler: HandlerDefinition<
		{ id: string; step: number },
		Input,
		{ waitMs: number } | null
	> = {
		kind: "model3d.cancel",
		payloadVersions: [1],
		schema: z.object({ id: z.uuid(), step: z.number().int() }),
		recovery: "replay_safe",
		resourceKey: "model3d",
		prepareInTransaction(db, claim) {
			const r = generationRow(db, claim.payload.id);
			if (
				!r ||
				r.step !== claim.payload.step ||
				r.state !== "cancelled" ||
				!r.job_id ||
				!r.service_path
			)
				return { status: "stale", reason: "model3d_state_changed" };
			return {
				status: "ready",
				input: { path: r.service_path, jobId: r.job_id },
			};
		},
		async execute(input, { signal }) {
			const sent = await guarded(
				() => larmOf(deps).cancel(input.path, input.jobId, bounded(signal)),
				deps.waitMs,
			);
			return sent.ok ? null : { waitMs: sent.waitMs };
		},
		classify: (e) =>
			e instanceof Error && e.message === "model3d_not_found"
				? "fail"
				: failsOnce(e),
		settleInTransaction(db, claim, _input, outcome) {
			const r = generationRow(db, claim.payload.id);
			if (!r || r.step !== claim.payload.step || r.state !== "cancelled")
				return "stale";
			if (outcome.type === "retry") return "applied";
			if (outcome.type === "success" && outcome.result) {
				deps.enqueue(db, r.id, "cancel", outcome.result.waitMs);
				return "applied";
			}
			// A job LARM no longer knows is as good as cancelled.
			if (
				outcome.type !== "success" &&
				!("errorCode" in outcome && outcome.errorCode === "model3d_not_found")
			)
				deps.cancelUnconfirmed(
					db,
					patchGeneration(db, r.id, {
						error_code: "model3d_cancel_unconfirmed",
					}),
				);
			return "applied";
		},
		cancelInTransaction() {},
	};
	deps.queue.registerHandler(handler);
}

function registerOperation(deps: Deps) {
	type Input = {
		id: string;
		kind: "update" | "delete";
		assetId: string;
		patch: { title?: string; tags?: string[] } | null;
	};
	type Output = { asset: Model3dAsset | null } | { waitMs: number };
	const handler: HandlerDefinition<{ id: string }, Input, Output> = {
		kind: "model3d.operation",
		payloadVersions: [1],
		schema: z.object({ id: z.uuid() }),
		recovery: "interrupt",
		resourceKey: "model3d",
		prepareInTransaction(db, claim) {
			const o = operationRow(db, claim.payload.id);
			if (!o || o.state !== "pending")
				return { status: "stale", reason: "model3d_state_changed" };
			return {
				status: "ready",
				input: {
					id: o.id,
					kind: o.kind,
					assetId: o.asset_id,
					patch: o.patch_json ? JSON.parse(o.patch_json) : null,
				},
			};
		},
		async execute(input, { signal }) {
			const larm = larmOf(deps);
			const done = await guarded(
				async () =>
					input.kind === "delete"
						? (await larm.remove(input.assetId, bounded(signal)), null)
						: await larm.update(input.assetId, input.patch!, bounded(signal)),
				deps.waitMs,
			);
			return done.ok ? { asset: done.value } : { waitMs: done.waitMs };
		},
		classify: () => "fail",
		settleInTransaction(db, claim, input, outcome) {
			const o = operationRow(db, claim.payload.id);
			if (!o || o.state !== "pending") return "stale";
			if (outcome.type === "success" && "waitMs" in outcome.result) {
				settleOperation(db, o.id, "failed", "model3d_busy");
			} else if (outcome.type === "success" && "asset" in outcome.result) {
				if (o.kind === "delete") forgetAsset(db, o.owner, o.asset_id);
				else if (outcome.result.asset)
					rememberAssets(db, o.owner, [outcome.result.asset]);
				settleOperation(db, o.id, "completed", null);
			} else {
				const code =
					"errorCode" in outcome && /^model3d_[a-z_]+$/.test(outcome.errorCode)
						? outcome.errorCode
						: "model3d_operation_unconfirmed";
				// An asset LARM no longer has leaves the index either way.
				if (code === "model3d_not_found") forgetAsset(db, o.owner, o.asset_id);
				if (code === "model3d_not_found" && input?.kind === "delete")
					settleOperation(db, o.id, "completed", null);
				else settleOperation(db, o.id, "failed", code);
			}
			deps.notifyOperation(db, o.id);
			return "applied";
		},
		cancelInTransaction(db, job) {
			const o = operationRow(db, job.payload.id);
			if (o?.state === "pending")
				settleOperation(db, o.id, "failed", "model3d_operation_unconfirmed");
		},
	};
	deps.queue.registerHandler(handler);
}
