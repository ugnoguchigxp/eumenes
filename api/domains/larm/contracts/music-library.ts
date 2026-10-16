import { z } from "zod";
export const trackId = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/);
export const trackQuery = z.strictObject({
	q: z.string().max(512).default(""),
	tags: z
		.array(z.string().min(1).max(64))
		.max(32)
		.refine((tags) => tags.join(",").length <= 512)
		.default([]),
	favorite: z.boolean().optional(),
	sort: z.enum(["createdAt", "relevance"]).default("createdAt"),
	order: z.enum(["asc", "desc"]).default("desc"),
	limit: z.number().int().min(1).max(100).default(50),
	cursor: z.string().min(1).max(8192).optional(),
});
export type TrackQuery = z.infer<typeof trackQuery>;
export const musicTrack = z.object({
	id: trackId,
	title: z.string().min(1).max(200),
	tags: z.array(z.string().min(1).max(64)).max(32),
	prompt: z.string(),
	instrumental: z.boolean(),
	model: z.string(),
	format: z.enum(["opus", "mp3", "wav", "flac"]),
	durationSeconds: z.number().positive(),
	createdAt: z.string().datetime({ offset: true }),
	favorite: z.boolean(),
	audioUrl: z.string().min(1),
	metadataUrl: z.string().min(1),
});
export const musicTracks = z.object({
	tracks: musicTrack.array().max(100),
	total: z.number().int().nonnegative(),
	nextCursor: z.string().min(1).max(8192).optional(),
});
export const musicTags = z.object({
	tags: z.array(
		z.object({
			tag: z.string().min(1).max(64),
			count: z.number().int().positive(),
		}),
	),
});
export function trackQueryParams(query: TrackQuery) {
	const p = new URLSearchParams({
		sort: query.sort,
		order: query.order,
		limit: String(query.limit),
	});
	if (query.q) p.set("q", query.q);
	if (query.tags.length) p.set("tags", query.tags.join(","));
	if (query.favorite !== undefined) p.set("favorite", String(query.favorite));
	if (query.cursor) p.set("cursor", query.cursor);
	return p;
}
