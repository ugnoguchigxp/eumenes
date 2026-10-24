import { z } from "zod";

export const chatInputSchema = z.object({
	contractVersion: z.literal("larm-chat-input.v1"),
	maxRequestBytes: z
		.number()
		.int()
		.positive()
		.max(64 * 1024 * 1024),
	images: z.object({
		mimeTypes: z.array(z.enum(["image/jpeg", "image/png", "image/bmp"])).min(1),
		maxImages: z.number().int().positive().max(32),
		maxBytes: z
			.number()
			.int()
			.positive()
			.max(16 * 1024 * 1024),
		maxWidth: z.number().int().positive().max(32768),
		maxHeight: z.number().int().positive().max(32768),
		maxPixels: z
			.number()
			.int()
			.positive()
			.max(64 * 1024 * 1024),
		maxAspectRatio: z.number().positive().max(100),
		referenceTypes: z.tuple([z.literal("data-url")]),
		roles: z.tuple([z.literal("user")]),
		detail: z.literal("auto-only"),
		orientation: z.literal("encoded-pixels"),
		alpha: z.literal("discard"),
	}),
	tokenCounting: z.object({
		protocol: z.literal("llama-chat-token-count.v1"),
		endpoint: z.string().startsWith("/"),
	}),
	retention: z.object({
		inferenceAudit: z.enum(["off", "metadata", "full-required"]),
		requestPayloadStored: z.boolean(),
		maxRetentionSeconds: z.number().int().nonnegative(),
		encrypted: z.boolean(),
		tokenCountPayloadStored: z.literal(false),
		providerImageStore: z.literal(false),
		historyResendRequired: z.literal(true),
	}),
});
export type ChatInput = z.infer<typeof chatInputSchema>;
/** Backend-only decoded and normalized source; converted to ordered wire parts at send time. */
export type ChatImage = {
	mime: "image/jpeg" | "image/png" | "image/bmp";
	bytes: Uint8Array;
	width: number;
	height: number;
};
/**
 * One message of a chat request. An assistant message may carry the tool calls it made; a `tool` message is the
 * host's result of one of them (`tool_call_id`), sent back in the same generation.
 */
export type ChatMessage = {
	role: "system" | "user" | "assistant" | "tool";
	content: string;
	images?: ChatImage[];
	tool_calls?: Array<{
		id: string;
		type: "function";
		function: { name: string; arguments: string };
	}>;
	tool_call_id?: string;
};
export type ChatContentPart =
	| { type: "text"; text: string }
	| { type: "image_url"; image_url: { url: string } };
export const tokenCountSchema = z
	.object({
		contractVersion: z.literal("larm-chat-input-token-count.v1"),
		model: z.string(),
		promptTokens: z.number().int().nonnegative(),
		textTokens: z.number().int().nonnegative(),
		imageTokens: z.number().int().nonnegative(),
		imageCount: z.number().int().nonnegative(),
		requestedOutputTokens: z.number().int().positive(),
		safetyMarginTokens: z.number().int().nonnegative(),
		inputBudgetTokens: z.number().int().positive(),
		maxContextTokens: z.number().int().positive(),
		fits: z.boolean(),
		requestDigest: z.string().regex(/^[a-f0-9]{64}$/),
		runtime: z.string(),
		runtimeRelease: z.string().optional(),
		configRevision: z.string(),
		bootEpoch: z.string(),
		engineBuild: z.string(),
	})
	.refine((v) => v.promptTokens === v.textTokens + v.imageTokens);
