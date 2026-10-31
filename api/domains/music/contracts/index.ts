import { z } from "zod";
const capacityWait = z.object({
	/** When LARM's first free-memory refusal of this request arrived. */
	startedAt: z.number(),
	/** How many tries were scheduled after a refusal. */
	count: z.number().int(),
});
const musicArtwork = z.object({
	state: z.enum(["generating", "completed", "failed"]),
	revision: z.number().int(),
	errorCode: z.string().nullable(),
	/** `waiting_capacity` while the request waits for LARM's free memory. */
	phase: z.string().optional(),
	capacityWait: capacityWait.optional(),
});
export const musicRecord = z.object({
	id: z.string(),
	runId: z.string(),
	conversationId: z.string(),
	state: z.enum(["planning", "generating", "completed", "failed", "cancelled"]),
	title: z.string(),
	description: z.string(),
	prompt: z.string().nullable(),
	durationSeconds: z.number().nullable(),
	task: z.enum(["music", "sound-effect"]).optional(),
	runtime: z.string().optional(),
	instrumental: z.boolean().optional(),
	lyrics: z.string().optional(),
	language: z.string().optional(),
	phase: z.string(),
	jobId: z.string().nullable(),
	errorCode: z.string().nullable(),
	capacityWait: capacityWait.optional(),
	mime: z.string().nullable(),
	actualModel: z.string().nullable(),
	/** Artwork is generated on demand from the track's prompt; absent until requested. */
	artwork: musicArtwork.optional(),
	createdAt: z.number(),
	updatedAt: z.number(),
});
export type MusicRecord = z.infer<typeof musicRecord>;
/** The generation that produced a library track (LARM-only tracks have none). */
export const trackGeneration = musicRecord.pick({
	id: true,
	artwork: true,
	task: true,
	runtime: true,
});

import { trackQuery, trackId } from "../../larm/contracts";
export const playlistRecord = z.object({
	kind: z.literal("playlist"),
	id: z.string().uuid(),
	runId: z.string(),
	conversationId: z.string(),
	state: z.enum(["planning", "completed", "failed", "cancelled"]),
	title: z.string(),
	query: trackQuery.omit({ cursor: true }),
	trackIds: trackId.array().max(100),
	currentId: trackId.nullable(),
	errorCode: z.string().nullable(),
	createdAt: z.number(),
	updatedAt: z.number(),
});
export type PlaylistRecord = z.infer<typeof playlistRecord>;
export const playlistUpdate = z.strictObject({
	query: trackQuery.omit({ cursor: true }).optional(),
	currentId: trackId.nullable().optional(),
});

export { trackQuery, musicGenerationInput } from "../../larm/contracts";
