import { z } from "zod";

export const routerExportSinceSchema = z.iso.datetime({ offset: true });
const nullableText = z.string().nullable();
export const exportCardSchema = z.object({
	id: z.string(),
	kind: z.string(),
	name: z.string(),
	description: z.string(),
	useWhen: z.array(z.string()),
	avoidWhen: z.array(z.string()).nullable(),
	examples: z.array(z.string()).nullable(),
	operation: nullableText,
	minImpact: nullableText,
	highImpact: z.boolean().nullable(),
	requiresApproval: z.boolean().nullable(),
	enabled: z.boolean(),
	version: z.number().nullable(),
	revisionId: nullableText,
	updatedAt: nullableText,
	embeddingText: nullableText,
	embeddingPassages: z.array(z.string()).nullable(),
	routerText: z.string(),
});
export const exportUtteranceSchema = z.object({
	conversationId: z.string(),
	turnId: z.string(),
	messageId: nullableText,
	timestamp: nullableText,
	text: nullableText,
	previousUser: nullableText,
	previousAgent: nullableText,
	activeToolchainId: nullableText,
	activeTaskId: nullableText,
	resourceKinds: z.array(z.string()).nullable(),
});
export const exportChoiceSchema = z.object({
	turnId: z.string(),
	candidates: z.array(
		z.object({
			id: z.string(),
			rank: z.number(),
			similarity: z.number().nullable(),
			probability: z.number().nullable(),
		}),
	),
	selectedId: nullableText,
	route: z.enum(["llm", "router"]).nullable(),
	result: nullableText,
	recordedOutcome: nullableText,
	routerMode: z.enum(["shadow", "on"]).nullable(),
});
export const exportCorrectionSchema = z.object({
	id: z.string(),
	turnId: z.string(),
	wrongId: nullableText,
	rightId: z.string(),
	state: z.string(),
	timestamp: z.string(),
	updatedAt: z.string(),
});
export const exportEmbeddingSchema = z.object({
	cardId: z.string(),
	revisionId: z.string(),
	item: z.number(),
	spaceId: z.string(),
	modelId: nullableText,
	dimension: z.number(),
	vector: z.array(z.number()),
});
export const routerExportSchema = z.object({
	cards: z.array(exportCardSchema),
	utterances: z.array(exportUtteranceSchema),
	choices: z.array(exportChoiceSchema),
	corrections: z.array(exportCorrectionSchema),
	embeddings: z.array(exportEmbeddingSchema),
	manifest: z.object({
		schemaVersion: z.literal(1),
		withEmbeddings: z.boolean(),
		commitSha: nullableText,
		dirty: z.boolean().nullable(),
		exportedAt: z.string(),
		since: nullableText,
		counts: z.object({
			cards: z.number(),
			utterances: z.number(),
			choices: z.number(),
			corrections: z.number(),
			embeddings: z.number(),
		}),
		embeddingModel: nullableText,
		embeddingSpaces: z.array(
			z.object({
				spaceId: z.string(),
				modelId: nullableText,
				dimension: z.number(),
			}),
		),
		unavailableFields: z.array(
			z.object({
				field: z.string(),
				reason: z.string(),
				count: z.number().optional(),
			}),
		),
	}),
});
export type ExportCard = z.infer<typeof exportCardSchema>;
export type RouterExport = z.infer<typeof routerExportSchema>;
