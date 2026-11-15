import { z } from "zod";

export const videoGenerate = z.strictObject({
	prompt: z
		.string()
		.trim()
		.min(1)
		.max(8192)
		.describe("動画に描く場面・動き・音の説明"),
	title: z.string().trim().min(1).max(256).optional(),
	seed: z.number().int().min(0).max(2147483647).optional(),
});
