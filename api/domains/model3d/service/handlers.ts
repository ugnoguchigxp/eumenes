import { z } from "zod";
import type { Database } from "bun:sqlite";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import {
	isCapacityBusy,
	LARM_CAPACITY_TIMEOUT,
	LARM_CAPACITY_WAITING,
	settleCapacityWait,
	sendAgainIfLost,
	type CapacityWait,
} from "../../larm";
import type { HandlerDefinition, QueueService } from "../../queue";
import {
	isLarmRefusal,
	SOURCE_IMPORT_STAGE,
	type Model3dAsset,
	type Model3dLarm,
	type Model3dSharedImages,
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
/** What a re-enqueued submit carries: the capacity wait so far, and whether its one recovery was used. */
export type SubmitExtra = {
	capacity?: Pick<CapacityWait, "startedAt" | "count">;
	recovered?: true;
};
export type Deps = {
	store: SqliteStore;
	queue: QueueService;
	larm: () => Model3dLarm | null;
	enqueue: (
		db: Database,
		id: string,
		stage: Stage,
		delay?: number,
		extra?: SubmitExtra,
	) => string;
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
	/** How long a generation is followed once LARM accepts it. */
	followMs: number;
	/** Shared images the user attached (absent: such a source is not found). */
	sharedImages?: Model3dSharedImages;
};
type Body = Parameters<Model3dLarm["submit"]>[1];

/** LARM refusals that end the attempt with a code the user can act on. */
function refusalCode(e: unknown) {
	if (!isLarmRefusal(e)) return null;
	if (e.status === 400 || e.status === 422) return "model3d_invalid_request";
	if (e.status === 401 || e.status === 403) return "model3d_auth_failed";
	if (e.status === 404) return "model3d_not_found";
	if (e.status === 409) return "model3d_idempotency_conflict";
	if (e.status === 429) return "model3d_busy";
	if (e.status === 503) return "model3d_unavailable";
	if (e.status === 507) return "model3d_storage_full";
	return null;
}
function larmOf(deps: Deps) {
	const larm = deps.larm();
	if (!larm) throw new Error("model3d_larm_unconfigured");
	return larm;
}
/** One LARM call never holds the 3D queue longer than this. */
const CALL_MS = 60_000;
const bounded = (signal: AbortSignal) =>
	AbortSignal.any([signal, AbortSignal.timeout(CALL_MS)]);
/**
 * Any refusal becomes a model3d code and is not sent again. A capacity refusal (only the submit can
 * raise one) passes through: the submit decides to wait.
 */
async function guarded<T>(work: () => Promise<T>) {
	try {
		return await work();
	} catch (e) {
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
	/**
	 * A shared image becomes a LARM library image first (§11.1 of the scratch spec): saved once under the generation's
	 * id, then sent as any library image. The file is let go once LARM has it or the save failed.
	 */
	async function librarySource(
		input: Input,
		signal: AbortSignal,
	): Promise<Exclude<Model3dSource, { type: "shared-image" }>> {
		const { source } = input;
		if (source.type !== "shared-image") return source;
		const shared = deps.sharedImages;
		if (!shared) throw new Error("model3d_image_not_found");
		await deps.store.write((db) => {
			const r = generationRow(db, input.id);
			if (r?.state === "submitting" && r.stage !== SOURCE_IMPORT_STAGE)
				patchGeneration(db, r.id, { stage: SOURCE_IMPORT_STAGE });
		});
		try {
			return {
				type: "image-artifact",
				id: await shared.artifact(source.id, input.id, bounded(signal)),
			};
		} finally {
			shared.release(input.id);
		}
	}
	/** Fixes the body once, then sends it; the lost-response rule sends the same key once more. */
	async function send(input: Input, signal: AbortSignal) {
		const larm = larmOf(deps);
		let { body, path } = input;
		if (!body || !path) {
			const found = await guarded(() => larm.discover(bounded(signal)));
			if (!found.mesh) throw new Error("model3d_service_unavailable");
			if (input.source.type === "prompt" && !found.image)
				throw new Error("model3d_image_service_unavailable");
			const source = await librarySource(input, signal);
			const built: Body = {
				model: found.mesh.model,
				source:
					source.type === "prompt"
						? {
								type: "prompt",
								prompt: source.prompt,
								imageModel: found.image!.model,
							}
						: source,
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
					// The saved source image is LARM's now: the screen shows the send again.
					...(r.stage === SOURCE_IMPORT_STAGE ? { stage: null } : {}),
				});
				return { body: built, path: found.mesh!.path };
			});
			if (!fixed) throw new Error("model3d_state_changed");
			({ body, path } = fixed);
		}
		// The key is kept for every later try, so a capacity refusal after a lost response is a wait too.
		return await guarded(() =>
			sendAgainIfLost(
				() => larm.submit(path!, body!, input.key, bounded(signal)),
				true,
			),
		);
	}
	/** `capacityWait` is LARM's "no free memory" refusal; it carries Retry-After. */
	type Output = { jobId: string } | { capacityWait: number | null };
	type Payload = { id: string; step: number } & SubmitExtra;
	const handler: HandlerDefinition<Payload, Input, Output> = {
		kind: "model3d.submit",
		payloadVersions: [1],
		schema: z.object({
			id: z.uuid(),
			step: z.number().int(),
			capacity: z
				.object({ startedAt: z.number(), count: z.number().int() })
				.optional(),
			recovered: z.literal(true).optional(),
		}),
		// A restart mid-send is recovered once by settle, never replayed by the queue.
		recovery: "interrupt",
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
			// The scheduled send starts: it no longer waits, and a cancel from now on must find its job.
			if (r.stage === LARM_CAPACITY_WAITING)
				patchGeneration(db, r.id, { stage: null });
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
			try {
				return { jobId: await send(input, signal) };
			} catch (e) {
				if (isCapacityBusy(e)) return { capacityWait: e.retryAfterMs };
				throw e;
			}
		},
		classify: () => "fail",
		settleInTransaction(db, claim, _input, outcome) {
			const r = generationRow(db, claim.payload.id);
			if (!r || r.step !== claim.payload.step) return "stale";
			const { capacity, recovered } = claim.payload;
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
			if (outcome.type === "success" && "capacityWait" in outcome.result) {
				// Refused before acceptance: LARM holds no job, so a cancelled generation has nothing to learn.
				if (r.state !== "submitting") return "stale";
				const now = Date.now();
				// A deadline a task fixed is never extended; the wait must end inside it.
				const fixed = r.origin === "task";
				settleCapacityWait({
					domain: "model3d",
					subjectId: r.id,
					now,
					previous: capacity,
					retryAfterMs: outcome.result.capacityWait,
					budgetMs: fixed ? 0 : deps.followMs,
					limitAt: fixed ? r.deadline : null,
					expire: () =>
						deps.notify(
							db,
							patchGeneration(db, r.id, {
								state: "failed",
								stage: null,
								error_code: LARM_CAPACITY_TIMEOUT,
							}),
							"failed",
						),
					schedule(plan) {
						// The follow window starts when LARM accepts, so it moves with the wait.
						patchGeneration(db, r.id, {
							stage: LARM_CAPACITY_WAITING,
							...(fixed ? {} : { deadline: plan.deadline }),
						});
						// Refused before acceptance: the next send is a new try, not a recovery.
						return deps.enqueue(
							db,
							r.id,
							"submit",
							Math.max(0, plan.at - now),
							{
								capacity: { startedAt: plan.startedAt, count: plan.count },
							},
						);
					},
				});
				return "applied";
			}
			const resendOnly =
				r.state === "cancelled" && !r.job_id && !!r.request_json;
			if (
				outcome.type === "interrupted" &&
				!recovered &&
				(r.state === "submitting" || resendOnly)
			) {
				// The lost-response rule after a restart: one more send of the same fixed body and key.
				deps.enqueue(db, r.id, "submit", 0, {
					recovered: true,
					...(capacity ? { capacity } : {}),
				});
				return "applied";
			}
			if (r.state !== "submitting") return "stale";
			const code =
				"errorCode" in outcome && /^model3d_[a-z_]+$/.test(outcome.errorCode)
					? outcome.errorCode
					: "model3d_submission_unconfirmed";
			deps.notify(
				db,
				patchGeneration(db, r.id, {
					state: "failed",
					stage: null,
					error_code: code,
				}),
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
		// Following is GET only; patient waits re-enqueue it, the queue never runs it twice.
		recovery: "interrupt",
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
		classify: () => "fail",
		settleInTransaction(db, claim, _input, outcome) {
			const r = generationRow(db, claim.payload.id);
			if (
				!r ||
				r.step !== claim.payload.step ||
				!["queued", "running"].includes(r.state)
			)
				return "stale";
			// A restart only interrupts a status read (GET): follow again until the deadline.
			if (outcome.type === "interrupted" && Date.now() < r.deadline) {
				deps.enqueue(db, r.id, "poll", deps.pollMs);
				return "applied";
			}
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
	const handler: HandlerDefinition<{ id: string; step: number }, Input, null> =
		{
			kind: "model3d.cancel",
			payloadVersions: [1],
			schema: z.object({ id: z.uuid(), step: z.number().int() }),
			recovery: "interrupt",
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
				await guarded(() =>
					larmOf(deps).cancel(input.path, input.jobId, bounded(signal)),
				);
				return null;
			},
			classify: () => "fail",
			settleInTransaction(db, claim, _input, outcome) {
				const r = generationRow(db, claim.payload.id);
				if (!r || r.step !== claim.payload.step || r.state !== "cancelled")
					return "stale";
				if (
					outcome.type === "success" ||
					("errorCode" in outcome && outcome.errorCode === "model3d_not_found")
				)
					patchGeneration(db, r.id, { error_code: null });
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
	type Output = { asset: Model3dAsset | null };
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
			return {
				asset: await guarded(async () =>
					input.kind === "delete"
						? (await larm.remove(input.assetId, bounded(signal)), null)
						: await larm.update(input.assetId, input.patch!, bounded(signal)),
				),
			};
		},
		classify: () => "fail",
		settleInTransaction(db, claim, input, outcome) {
			const o = operationRow(db, claim.payload.id);
			if (!o || o.state !== "pending") return "stale";
			if (outcome.type === "success") {
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
