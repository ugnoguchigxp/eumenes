import type { Database } from "bun:sqlite";
import { z } from "zod";
import type { HandlerDefinition } from "../../queue";
import {
	findServiceTarget,
	isCapacityBusy,
	LARM_CAPACITY_TIMEOUT,
	LARM_CAPACITY_WAITING,
	planCapacityWait,
	type TestOutput,
} from "../../larm";
import { MEDIA_GENERATION_TIMEOUT_MS } from "../../capabilities";
import { getLogger } from "../../../infrastructure/logger";
import type { MusicRecord } from "../contracts";
import { row, record, patch, media } from "../repository";
import type { createMusic } from "./index";
const log = getLogger("music");
const payload = z.object({ id: z.string(), revision: z.number().int() });
const SIZE = 256;
const MAX_BYTES = 4 * 1024 * 1024;
const safeError = (error: unknown) =>
	error instanceof Error && /^[a-z_0-9]{1,80}$/.test(error.message)
		? error.message
		: "music_artwork_failed";
/** The track's own production prompt drives the image; the title is shown by the UI, not drawn. */
function artworkPrompt(r: MusicRecord) {
	return [
		`Square album cover artwork for the song "${r.title}".`,
		r.description && `Theme: ${r.description}`,
		`Music: ${r.prompt}`,
		"Evocative illustration that matches the mood. No text, no letters, no logos.",
	]
		.filter(Boolean)
		.join("\n")
		.slice(0, 8000);
}
export class MusicArtworkError extends Error {
	constructor(
		readonly code: string,
		readonly status: 404 | 409,
	) {
		super(code);
	}
}
export function createArtwork(deps: Parameters<typeof createMusic>[0]) {
	const { store, queue } = deps;
	const current = (db: Database, id: string, revision: number) => {
		const r = row(db, id);
		const v = r && record(r);
		return v?.artwork?.state === "generating" && v.artwork.revision === revision
			? r
			: null;
	};
	/** LARM had no free memory: the artwork request waits and is queued again, never sent from here. */
	type CapacityWait = { capacityWait: number | null };
	const handler: HandlerDefinition<
		{ id: string; revision: number },
		{ id: string; revision: number; prompt: string },
		TestOutput | CapacityWait
	> = {
		kind: "music.artwork",
		payloadVersions: [1],
		schema: payload,
		recovery: "interrupt",
		resourceKey: "image.generate",
		prepareInTransaction(db, claim) {
			const r = current(db, claim.payload.id, claim.payload.revision);
			if (!r)
				return { status: "stale", reason: "music_artwork_not_generating" };
			const { phase: waiting, ...artwork } = record(r).artwork!;
			if (waiting) patch(db, r.id, { artwork });
			return {
				status: "ready",
				input: { ...claim.payload, prompt: artworkPrompt(record(r)) },
			};
		},
		async execute(input, { signal }) {
			try {
				const gateway = deps.gateway();
				const catalog = await gateway.catalog(signal);
				const target = findServiceTarget(
					catalog.targets,
					"media.image.generate",
					"larm.image-generation.v1",
				);
				if (!target || !target.description?.trim())
					throw new Error("image_service_unavailable");
				const output = await gateway.execute(
					target,
					{ text: input.prompt, width: SIZE, height: SIZE, format: "png" },
					signal,
					async () => {},
				);
				if (!output.bytes?.length || !output.mime?.startsWith("image/"))
					throw new Error("music_artwork_missing");
				if (output.bytes.length > MAX_BYTES)
					throw new Error("music_artwork_too_large");
				// The track keeps its own copy; do not leave artwork in the image studio's library.
				if (output.artifact)
					await gateway.images
						.remove(output.artifact.id, signal)
						.catch(() => {});
				return output;
			} catch (e) {
				if (isCapacityBusy(e)) return { capacityWait: e.retryAfterMs };
				throw new Error(safeError(e));
			}
		},
		classify: () => "fail",
		settleInTransaction(db, claim, input, outcome) {
			const r = current(db, claim.payload.id, claim.payload.revision);
			if (!r) return "stale";
			const {
				phase: _phase,
				capacityWait: previous,
				...artwork
			} = record(r).artwork!;
			if (
				outcome.type === "success" &&
				input &&
				"capacityWait" in outcome.result
			) {
				const now = Date.now();
				const plan = planCapacityWait({
					now,
					previous,
					retryAfterMs: outcome.result.capacityWait,
					budgetMs: MEDIA_GENERATION_TIMEOUT_MS,
				});
				if (!plan) {
					log.warn("music.capacity_wait_expired", {
						reason: LARM_CAPACITY_TIMEOUT,
						waitedMs: now - (previous?.startedAt ?? now),
					});
					patch(db, r.id, {
						artwork: {
							...artwork,
							state: "failed",
							errorCode: LARM_CAPACITY_TIMEOUT,
						},
					});
					return "applied";
				}
				const { job } = queue.enqueueInTransaction(db, {
					scope: "music",
					kind: "music.artwork",
					dedupeKey: `${r.id}:artwork:${artwork.revision}:w${plan.count}`,
					payload: claim.payload,
					subjectRef: r.id,
					lane: "interactive",
					resourceKey: "image.generate",
					maxAttempts: 1,
					availableAtMs: plan.at,
					deadlineAtMs: plan.deadline,
				});
				patch(db, r.id, {
					artwork: {
						...artwork,
						phase: LARM_CAPACITY_WAITING,
						capacityWait: { startedAt: plan.startedAt, count: plan.count },
					},
				});
				log.info("music.capacity_wait_scheduled", {
					jobId: job.id,
					subjectId: r.id,
					waitCount: plan.count,
					waitedMs: now - plan.startedAt,
					nextInMs: plan.at - now,
				});
				return "applied";
			}
			if (outcome.type !== "success" || !input) {
				patch(db, r.id, {
					artwork: {
						...artwork,
						state: "failed",
						errorCode:
							"errorCode" in outcome
								? outcome.errorCode
								: outcome.type === "expired"
									? "deadline_exceeded"
									: "music_artwork_interrupted",
					},
				});
				return "applied";
			}
			const output = outcome.result as TestOutput;
			db.query(
				"UPDATE music_generations SET artwork=?, artwork_mime=? WHERE id=?",
			).run(output.bytes!, output.mime!, r.id);
			patch(db, r.id, {
				artwork: { ...artwork, state: "completed", errorCode: null },
			});
			return "applied";
		},
		cancelInTransaction(db, job) {
			const r = current(db, job.payload.id, job.payload.revision);
			if (!r) return;
			const {
				phase: _phase,
				capacityWait: _wait,
				...artwork
			} = record(r).artwork!;
			patch(db, r.id, {
				artwork: { ...artwork, state: "failed", errorCode: "cancel_requested" },
			});
		},
	};
	queue.registerHandler(handler);
	return {
		/** Starts (or restarts) artwork generation for a completed track. */
		request: async (id: string) => {
			const result = await store.write((db) => {
				const r = row(db, id);
				if (!r) throw new MusicArtworkError("music_not_found", 404);
				const v = record(r);
				if (v.state !== "completed" || !v.prompt)
					throw new MusicArtworkError("music_not_completed", 409);
				if (v.artwork?.state === "generating")
					throw new MusicArtworkError("music_artwork_generating", 409);
				const revision = (v.artwork?.revision ?? 0) + 1;
				queue.enqueueInTransaction(db, {
					scope: "music",
					kind: "music.artwork",
					dedupeKey: `${id}:artwork:${revision}`,
					payload: { id, revision },
					subjectRef: id,
					lane: "interactive",
					resourceKey: "image.generate",
					maxAttempts: 1,
					deadlineAtMs: Date.now() + MEDIA_GENERATION_TIMEOUT_MS,
				});
				return patch(db, id, {
					artwork: { state: "generating", revision, errorCode: null },
				});
			});
			queue.wake();
			return result;
		},
		content: (id: string) =>
			store.read((db) => {
				const a = media(db, id, "artwork");
				return a?.bytes && a.mime ? { bytes: a.bytes, mime: a.mime } : null;
			}),
	};
}
