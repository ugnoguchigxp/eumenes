import { z } from "zod";
const page = {
	pageIndex: z.coerce.number().int().min(0).max(100000).default(0),
	pageSize: z.coerce
		.number()
		.pipe(z.union([z.literal(10), z.literal(25), z.literal(50)]))
		.default(10),
	q: z.string().trim().max(200).default(""),
	desc: z
		.union([z.boolean(), z.enum(["true", "false"])])
		.transform((v) => v === true || v === "true")
		.default(true),
};
export const selectionPageQuerySchema = z.strictObject({
	...page,
	sort: z.enum(["createdAt", "process", "outcome"]).default("createdAt"),
});
export const recipePageQuerySchema = z.strictObject({
	...page,
	sort: z
		.enum(["updatedAt", "signature", "state", "successes", "failures"])
		.default("updatedAt"),
});
export type SelectionPageQuery = z.output<typeof selectionPageQuerySchema>;
export type RecipePageQuery = z.output<typeof recipePageQuerySchema>;
