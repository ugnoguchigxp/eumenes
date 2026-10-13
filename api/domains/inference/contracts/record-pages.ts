import { z } from "zod";
export const usagePageQuerySchema = z.strictObject({
	pageIndex: z.coerce.number().int().min(0).max(100000).default(0),
	pageSize: z.coerce
		.number()
		.pipe(z.union([z.literal(10), z.literal(25), z.literal(50)]))
		.default(10),
	q: z.string().trim().max(200).default(""),
	sort: z
		.enum(["started", "purpose", "source", "model", "status"])
		.default("started"),
	desc: z
		.union([z.boolean(), z.enum(["true", "false"])])
		.transform((v) => v === true || v === "true")
		.default(true),
});
export type UsagePageQuery = z.output<typeof usagePageQuerySchema>;
