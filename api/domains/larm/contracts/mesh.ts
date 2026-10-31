import { z } from "zod";

/** Catalog keys of LARM's 3D generation service and of the image service that draws its source image. */
export const MESH_CAPABILITY = "media.mesh.generate";
export const MESH_PROTOCOL = "larm.mesh-generation.v1";
export const MESH_IMAGE_CAPABILITY = "media.image.generate";
export const MESH_IMAGE_PROTOCOL = "larm.image-generation.v1";
/** The generation path LARM publishes for the 3D service (larm.mesh-generation.v1). */
export const MESH_GENERATIONS_PATH = "/v1/3d/generations";

export const meshId = z
	.string()
	.min(1)
	.max(128)
	.regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);

const service = z.object({
	capability: z.string(),
	protocol: z.string(),
	model: z.string().min(1).max(256),
	url: z.string().min(1).max(2048),
	description: z.string().max(8192).optional(),
});
export const meshCatalog = z.object({
	contractVersion: z.literal("agent-connection.v3"),
	services: z.array(z.unknown()).max(512),
});
export const meshCatalogService = service;

export const meshSource = z.discriminatedUnion("type", [
	z.strictObject({
		type: z.literal("prompt"),
		prompt: z.string().min(1).max(2000),
		imageModel: z.string().min(1).max(256),
	}),
	z.strictObject({ type: z.literal("image-artifact"), id: meshId }),
]);
/** The body sent to `POST <service url>`; `steps` is LARM's and never sent. */
export const meshGenerationRequest = z.strictObject({
	model: z.string().min(1).max(256),
	source: meshSource,
	title: z.string().min(1).max(80),
	tags: z.array(z.string().min(1).max(24)).max(8),
	resolution: z.literal(512),
	seed: z.number().int().nonnegative().max(2_147_483_647),
});
export type MeshGenerationRequest = z.infer<typeof meshGenerationRequest>;

export const meshAccepted = z.object({ jobId: meshId });

export const meshJobStatus = z.enum([
	"queued",
	"running",
	"completed",
	"failed",
	"cancelled",
]);
/** Free text from LARM is cut to a bound instead of rejecting the whole answer. */
const text = (max: number) => z.string().transform((v) => v.slice(0, max));
const warning = z.union([
	text(1000),
	z
		.object({ message: text(1000).optional(), code: text(100).optional() })
		.transform((w) => w.message ?? w.code ?? ""),
]);
export const meshWarnings = z
	.array(warning)
	.transform((w) => w.filter(Boolean).slice(0, 32));

/** One generation job as LARM reports it; stage and status are separate fields. */
export const meshJob = z.object({
	jobId: meshId,
	status: meshJobStatus,
	stage: text(64).nullish(),
	deleted: z.boolean().optional(),
	assetId: meshId.nullish(),
	asset: z.object({ id: meshId, warnings: meshWarnings.optional() }).nullish(),
	error: z
		.union([
			text(200),
			z.object({ code: text(100).optional() }).transform((e) => e.code ?? ""),
		])
		.nullish(),
	errorCode: text(100).nullish(),
	reason: text(100).nullish(),
	warnings: meshWarnings.optional(),
});

/** A saved 3D asset; LARM owns it, Eumenes keeps only these fields. */
export const meshAsset = z
	.object({
		id: meshId,
		title: text(200).nullish(),
		tags: z
			.array(text(64))
			.transform((t) => t.slice(0, 64))
			.optional(),
		createdAt: z.string().max(64),
		prompt: z.string().nullish(),
		source: z
			.looseObject({
				type: z.string().optional(),
				prompt: z.string().optional(),
			})
			.nullish(),
		warnings: meshWarnings.optional(),
		sourceUrl: z.string().nullish(),
		urls: z.record(z.string(), z.unknown()).nullish(),
	})
	.transform((a) => {
		const prompt = a.prompt ?? a.source?.prompt ?? null;
		return {
			id: a.id,
			title: a.title?.trim() || "無題の3Dモデル",
			tags: a.tags ?? [],
			createdAt: a.createdAt,
			prompt: prompt ? prompt.slice(0, 2000) : null,
			warnings: a.warnings ?? [],
			hasSource: !!(a.sourceUrl ?? a.urls?.source),
		};
	});
export const meshAssetPage = z.object({
	assets: z.array(z.unknown()).max(100),
	total: z.number().int().nonnegative(),
	nextCursor: z.string().max(2048).nullish(),
});
export const meshAssetQuery = z.strictObject({
	q: z.string().max(200).optional(),
	tags: z.array(z.string().min(1).max(64)).max(8).optional(),
	sort: z.enum(["createdAt", "relevance"]).optional(),
	order: z.enum(["asc", "desc"]).optional(),
	limit: z.number().int().min(1).max(100).optional(),
	cursor: z.string().min(1).max(2048).optional(),
});
export type MeshAssetQuery = z.infer<typeof meshAssetQuery>;
export const meshAssetPatch = z
	.strictObject({
		title: z.string().trim().min(1).max(80).optional(),
		tags: z.array(z.string().trim().min(1).max(24)).max(8).optional(),
	})
	.refine((p) => p.title !== undefined || p.tags !== undefined);
export type MeshAssetPatch = z.infer<typeof meshAssetPatch>;
