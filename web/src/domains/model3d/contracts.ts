import { z } from "zod";

/** The Web side of the `/api/model3d/*` contract (spec §14.2). */
export const model3dSource = z.discriminatedUnion("type", [
	z.strictObject({ type: z.literal("prompt"), prompt: z.string() }),
	z.strictObject({ type: z.literal("image-artifact"), id: z.string() }),
]);
export type Model3dSource = z.infer<typeof model3dSource>;

export const model3dGeneration = z.looseObject({
	id: z.string(),
	title: z.string(),
	tags: z.array(z.string()),
	source: model3dSource,
	state: z.enum([
		"submitting",
		"queued",
		"running",
		"completed",
		"failed",
		"cancelled",
	]),
	stage: z.string().nullable(),
	stageLabel: z.string(),
	assetId: z.string().nullable(),
	deleted: z.boolean(),
	warnings: z.array(z.string()),
	errorCode: z.string().nullable(),
	errorLabel: z.string().nullable(),
	origin: z.enum(["conversation", "screen"]),
	createdAt: z.number(),
	updatedAt: z.number(),
	revision: z.number(),
});
export type Model3dGeneration = z.infer<typeof model3dGeneration>;
export const model3dGenerationList = z.looseObject({
	generations: z.array(model3dGeneration),
});

export const model3dAsset = z.looseObject({
	id: z.string(),
	title: z.string(),
	tags: z.array(z.string()),
	createdAt: z.string(),
	prompt: z.string().nullable(),
	warnings: z.array(z.string()),
	hasSource: z.boolean(),
});
export type Model3dAsset = z.infer<typeof model3dAsset>;

export const model3dAssetPage = z.looseObject({
	assets: z.array(model3dAsset),
	total: z.number(),
	nextCursor: z.string().nullable(),
});
export const model3dStatus = z.looseObject({
	available: z.boolean(),
	reason: z.string().nullable(),
});

const focus = z.discriminatedUnion("kind", [
	z.looseObject({
		seq: z.number(),
		kind: z.literal("asset"),
		assetId: z.string(),
	}),
	z.looseObject({
		seq: z.number(),
		kind: z.literal("search"),
		query: z.string(),
		tags: z.array(z.string()),
	}),
	z.looseObject({
		seq: z.number(),
		kind: z.literal("generation"),
		generationId: z.string(),
	}),
]);

/** The backend's data for the screen source (`query:model3d.workspace@1`). */
export const model3dSourceData = z.looseObject({
	generations: z.array(model3dGeneration),
	focus: focus.nullable(),
	available: z.boolean(),
	reason: z.string().nullable(),
});
export type Model3dSourceData = z.infer<typeof model3dSourceData>;

export type Model3dQuery = {
	q: string;
	tags: string[];
	sort: "createdAt" | "relevance";
	order: "asc" | "desc";
};
export type Model3dGenerateBody = {
	requestId: string;
	title: string;
	tags: string[];
	source: Model3dSource;
};

/** Largest GLB the viewer reads (spec §8.3). */
export const maxGlbBytes = 64 * 1024 * 1024;
export const assetsPageSize = 20;

/** Splits comma and Japanese comma separated tags; trims, drops empty ones and repeats. */
export function parseTags(text: string): string[] {
	return [
		...new Set(
			text
				.split(/[,、，]/)
				.map((tag) => tag.trim())
				.filter(Boolean),
		),
	];
}
