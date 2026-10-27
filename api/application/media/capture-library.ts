import type { Database } from "bun:sqlite";
import { z } from "zod";
import type { QueueService } from "../../domains/queue";
import type { ImageService } from "../../domains/image";
import type { ObjectRecognitionService } from "../../domains/object-recognition";

/** Answers another attempt with the same capture and connection cannot change: the save failed. */
const rejected = new Set([
	"capture_save_connection_changed",
	"image_import_connection_changed",
	"image_invalid",
	"image_format_unsupported",
	"image_mime_mismatch",
	"image_too_large",
	"image_dimensions_exceeded",
	"idempotency_conflict",
]);

/**
 * LARM accepted the image and is still saving it: the job reads the same receipt again. A receipt
 * LARM never admitted, or one that could not be confirmed, is left to the user (recheck, resume).
 */
const unsettled = new Set(["pending"]);
/** How long one attempt reads a receipt LARM is still saving, and the job's hard limit. */
const pollBudgetMs = 2 * 60_000;
const saveDeadlineMs = 10 * 60_000;

const pause = (ms: number, signal: AbortSignal) =>
	new Promise<void>((resolve) => {
		const done = () => {
			clearTimeout(timer);
			signal.removeEventListener("abort", done);
			resolve();
		};
		const timer = setTimeout(done, ms);
		signal.addEventListener("abort", done, { once: true });
	});

/** The durable job links a capture to the existing image import by the same UUID. */
export function registerCaptureLibrary(
	queue: QueueService,
	image: ImageService,
	recognition: () => ObjectRecognitionService,
	connectionIdentity: () => string,
	now: () => number = Date.now,
) {
	const schema = z.object({
		id: z.uuid(),
		owner: z.string(),
		connection: z.string(),
	});
	queue.registerHandler({
		kind: "capture-library.save",
		payloadVersions: [1],
		schema,
		recovery: "replay_safe",
		prepareInTransaction(_db, claim) {
			return { status: "ready", input: claim.payload };
		},
		async execute(input, { signal }) {
			if (connectionIdentity() !== input.connection)
				throw new Error("capture_save_connection_changed");
			const source = recognition().content(input.owner, input.id);
			const file = new File([new Uint8Array(source.bytes)], "capture", {
				type: source.mime,
			});
			let result = await image.imports.upload(
				input.id,
				file,
				signal,
				input.connection,
			);
			// LARM may still be saving: read the same receipt at the interval it asks for.
			const until = now() + pollBudgetMs;
			while (unsettled.has(result.status) && now() < until && !signal.aborted) {
				await pause(
					Math.min(15_000, Math.max(1_000, result.retryAfterMs)),
					signal,
				);
				if (connectionIdentity() !== input.connection) break;
				result = await image.imports.read(input.id, signal);
			}
			if (connectionIdentity() !== input.connection)
				throw new Error("capture_save_connection_changed");
			// Still unsettled: the queue tries again later with the same receipt.
			if (unsettled.has(result.status)) throw new Error("capture_save_pending");
			return result;
		},
		classify: (error) =>
			error instanceof Error && error.message === "capture_save_pending"
				? "retry"
				: "fail",
		settleInTransaction(db, claim, _input, outcome) {
			if (outcome.type === "retry") return "applied";
			const state =
				outcome.type === "success"
					? outcome.result.status === "succeeded" && outcome.result.artifact
						? "saved"
						: ["failed", "blocked", "expired", "deleted"].includes(
									outcome.result.status,
							  )
							? "failed"
							: "unconfirmed"
					: outcome.type === "failed" && rejected.has(outcome.errorCode)
						? "failed"
						: "unconfirmed";
			if (
				!recognition().setCaptureSaveInTransaction(
					db,
					claim.payload.owner,
					claim.payload.id,
					state,
				)
			)
				return "stale";
			return state === "saved"
				? "applied"
				: {
						status: "failed",
						errorCode:
							state === "failed"
								? "capture_save_failed"
								: "capture_save_unconfirmed",
					};
		},
		cancelInTransaction(db, job) {
			recognition().setCaptureSaveInTransaction(
				db,
				job.payload.owner,
				job.payload.id,
				"unconfirmed",
			);
		},
	});
	const enqueue = (db: Database, input: { id: string; owner: string }) => {
		queue.enqueueInTransaction(db, {
			scope: "image",
			kind: "capture-library.save",
			dedupeKey: input.id,
			payload: { ...input, connection: connectionIdentity() },
			subjectRef: input.id,
			lane: "background",
			maxAttempts: 3,
			// A save that never answers ends as unconfirmed instead of keeping the capture undeletable.
			deadlineAtMs: now() + saveDeadlineMs,
		});
	};
	return Object.assign(enqueue, {
		resumeInTransaction(db: Database, input: { id: string; owner: string }) {
			const original = queue.findByDedupeInTransaction(
				db,
				"image",
				"capture-library.save",
				input.id,
			);
			if (!original) throw new Error("capture_save_unavailable");
			const payload = schema.parse(JSON.parse(original.payloadJson));
			if (
				payload.owner !== input.owner ||
				payload.id !== input.id ||
				payload.connection !== connectionIdentity()
			)
				throw new Error("capture_save_connection_changed");
			queue.enqueueInTransaction(db, {
				scope: "image",
				kind: "capture-library.save",
				dedupeKey: `${input.id}:resume:${crypto.randomUUID()}`,
				payload,
				subjectRef: input.id,
				lane: "background",
				maxAttempts: 3,
				deadlineAtMs: now() + saveDeadlineMs,
			});
		},
	});
}
