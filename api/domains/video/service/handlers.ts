import type { Database } from "bun:sqlite";
import { z } from "zod";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import { isOnDemandBusy, VideoHttpError, type VideoClient } from "../../larm";
import type { HandlerDefinition, QueueService } from "../../queue";
import { videoInput } from "../contracts";
import { freezePost, jobOf, patch, row, type VideoRow } from "../repository";

type Operation = "submit" | "poll";
type Payload = { id: string; revision: number; operation: Operation };
type Update = Awaited<ReturnType<VideoClient["status"]>>;
type Result =
	{ update: Update } | { failure: Failure } | { trackingChanged: true };
type Failure = {
	code: string;
	retryAfterMs?: number;
	definite: boolean;
	trackingLost: boolean;
};
const nextPoll = (retryAfterMs?: number | null) =>
	Math.min(
		Number.MAX_SAFE_INTEGER,
		Date.now() + Math.max(2000, retryAfterMs ?? 3000),
	);
export const active = (job: Update["job"]) =>
	job.status === "queued" || job.status === "running";

function classify(error: unknown): Failure {
	if (isOnDemandBusy(error))
		return { code: error.message, definite: true, trackingLost: false };
	if (error instanceof VideoHttpError)
		return {
			code: error.code,
			definite:
				error.status < 500 ||
				["video_unavailable", "not_configured", "video_storage_full"].includes(
					error.code,
				),
			trackingLost: [401, 403, 404].includes(error.status),
			retryAfterMs: error.retryAfterMs ?? undefined,
		};
	return {
		code: "video_connection_failed",
		definite: false,
		trackingLost: false,
	};
}

export function saveJob(db: Database, r: VideoRow, update: Update) {
	const previous = jobOf(r);
	const next = update.job;
	if (
		previous &&
		(previous.jobId !== next.jobId ||
			!active(previous) ||
			Date.parse(previous.updatedAt) > Date.parse(next.updatedAt) ||
			(active(next) &&
				previous.phase === "stopping" &&
				next.phase !== "stopping"))
	)
		return false;
	patch(db, r.id, {
		job_json: JSON.stringify(next),
		state: active(next) ? "tracking" : "finished",
		error_code: next.error?.code ?? null,
		retry_at: nextPoll(update.retryAfterMs),
	});
	return true;
}

export function registerVideoJobs(deps: {
	store: SqliteStore;
	queue: QueueService;
	port: () => VideoClient | null;
}) {
	function enqueue(db: Database, r: VideoRow, operation: Operation) {
		deps.queue.enqueueInTransaction(db, {
			scope: "video",
			kind: "video.advance",
			dedupeKey: `${r.id}:${r.revision}:${operation}`,
			payload: { id: r.id, revision: r.revision, operation },
			subjectRef: r.id,
			lane: "interactive",
			concurrencyKey: `video:${r.id}`,
			availableAtMs: operation === "poll" ? r.retry_at : Date.now(),
			maxAttempts: 1,
		});
	}

	async function submit(
		port: VideoClient,
		r: VideoRow,
		signal: AbortSignal,
	): Promise<Result> {
		let { body_json: body, endpoint } = r;
		if (!body || !endpoint) {
			const service = await port.discover(signal);
			const input = videoInput.parse(JSON.parse(r.input_json));
			if (input.width !== undefined || input.durationSeconds !== undefined) {
				const options = await port.options(service.path, signal);
				if (
					(input.width !== undefined &&
						!options.sizes.some(
							(size) =>
								size.width === input.width && size.height === input.height,
						)) ||
					(input.durationSeconds !== undefined &&
						!options.durations.includes(input.durationSeconds))
				)
					throw new VideoHttpError(400, "invalid_video_request");
			}
			const frozenBody = JSON.stringify({ model: service.model, ...input });
			const frozenEndpoint = service.path;
			const fixed = await deps.store.write((db) => {
				const current = row(db, r.id);
				if (current?.revision !== r.revision || current.state !== "submitting")
					return false;
				// This update freezes the POST bytes without advancing the claimed step.
				freezePost(db, r.id, frozenBody, frozenEndpoint);
				return true;
			});
			if (!fixed) return { trackingChanged: true };
			body = frozenBody;
			endpoint = frozenEndpoint;
		}
		return { update: await port.submit(endpoint, body, r.id, signal) };
	}
	const handler: HandlerDefinition<
		Payload,
		VideoRow & { operation: Operation },
		Result
	> = {
		kind: "video.advance",
		payloadVersions: [1],
		schema: z.object({
			id: z.uuid(),
			revision: z.number().int(),
			operation: z.enum(["submit", "poll"]),
		}),
		recovery: "interrupt",
		prepareInTransaction(db, { payload }) {
			const r = row(db, payload.id);
			if (
				!r ||
				r.revision !== payload.revision ||
				(payload.operation === "submit"
					? r.state !== "submitting"
					: r.state !== "tracking")
			)
				return { status: "stale", reason: "video_state_changed" };
			return { status: "ready", input: { ...r, operation: payload.operation } };
		},
		async execute(input, { signal }) {
			const port = deps.port();
			if (!port || port.binding !== input.binding)
				return {
					failure: {
						code: "video_connection_changed",
						trackingLost: true,
						definite: !input.body_json,
					},
				};
			try {
				if (input.operation === "poll")
					return { update: await port.status(jobOf(input)!, signal) };
				return await submit(port, input, signal);
			} catch (error) {
				const failure = classify(error);
				// Discovery failed before any POST was attempted.
				if (
					input.operation === "submit" &&
					!input.body_json &&
					!deps.store.read((db) => row(db, input.id)?.body_json)
				)
					failure.definite = true;
				return { failure };
			}
		},
		settleInTransaction(db, claim, _input, outcome) {
			const r = row(db, claim.payload.id);
			if (!r || r.revision !== claim.payload.revision) return "stale";
			const result = outcome.type === "success" ? outcome.result : null;
			if (result && "trackingChanged" in result) return "stale";
			if (result && "update" in result) {
				if (!saveJob(db, r, result.update))
					patch(db, r.id, {
						retry_at: nextPoll(result.update.retryAfterMs),
					});
			} else {
				const failure = result?.failure ?? {
					code: "video_connection_failed",
					definite: false,
					trackingLost: false,
				};
				patch(db, r.id, {
					state:
						claim.payload.operation === "submit"
							? failure.definite
								? "rejected"
								: "unconfirmed"
							: failure.trackingLost
								? "unconfirmed"
								: "tracking",
					error_code: failure.code,
					retry_at: nextPoll(failure.retryAfterMs),
				});
			}
			const current = row(db, r.id)!;
			if (current.state === "tracking") enqueue(db, current, "poll");
			return "applied";
		},
		cancelInTransaction(db, { payload }) {
			const r = row(db, payload.id);
			if (r?.revision === payload.revision)
				patch(db, r.id, {
					state: "unconfirmed",
					error_code: "video_connection_failed",
				});
		},
	};
	deps.queue.registerHandler(handler);
	return enqueue;
}
