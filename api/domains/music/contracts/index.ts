import { z } from "zod";
export const musicArtwork = z.object({
	state: z.enum(["generating", "completed", "failed"]),
	revision: z.number().int(),
	errorCode: z.string().nullable(),
});
export type MusicArtwork = z.infer<typeof musicArtwork>;
export const musicRecord = z.object({
	id: z.string(),
	runId: z.string(),
	conversationId: z.string(),
	state: z.enum(["planning", "generating", "completed", "failed", "cancelled"]),
	title: z.string(),
	description: z.string(),
	prompt: z.string().nullable(),
	durationSeconds: z.number().nullable(),
	instrumental: z.boolean().optional(),
	lyrics: z.string().optional(),
	language: z.string().optional(),
	phase: z.string(),
	jobId: z.string().nullable(),
	errorCode: z.string().nullable(),
	mime: z.string().nullable(),
	actualModel: z.string().nullable(),
	/** Artwork is generated on demand from the track's prompt; absent until requested. */
	artwork: musicArtwork.optional(),
	createdAt: z.number(),
	updatedAt: z.number(),
});
export type MusicRecord = z.infer<typeof musicRecord>;

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

export { trackQuery, type TrackQuery } from "../../larm/contracts";
