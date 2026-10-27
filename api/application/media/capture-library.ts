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

/** The durable job links a capture to the existing image import by the same UUID. */
export function registerCaptureLibrary(
	queue: QueueService,
	image: ImageService,
	recognition: () => ObjectRecognitionService,
	connectionIdentity: () => string,
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
			const result = await image.imports.upload(
				input.id,
				file,
				signal,
				input.connection,
			);
			if (connectionIdentity() !== input.connection)
				throw new Error("capture_save_connection_changed");
			return result;
		},
		classify: () => "fail",
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
			});
		},
	});
}
