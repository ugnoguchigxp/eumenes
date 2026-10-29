import { z } from "zod";

/** Read-only display parameters of the TODO screen (the dialogue ledger's page query). */
export const todoQuery = z.object({
	state: z.enum(["active", "archived"]),
	pageIndex: z.coerce.number().int().min(0).max(1_000_000).default(0),
	pageSize: z.coerce
		.number()
		.pipe(z.union([z.literal(10), z.literal(20), z.literal(25), z.literal(50)]))
		.default(10),
});
export type TodoQuery = z.infer<typeof todoQuery>;
export const todoSourceQuery = todoQuery.extend({
	conversationId: z.string().min(1).max(120),
});

/** One TODO as the screen shows it: its whole request, state, outcome and the result's summary in full, never the result body. */
const todoRowSchema = z.object({
	id: z.string(),
	request: z.string(),
	status: z.enum(["todo", "waiting", "done"]),
	outcome: z
		.enum(["succeeded", "partial", "failed", "cancelled", "interrupted"])
		.nullable(),
	summary: z.string().nullable(),
	pipeline: z.boolean(),
	archived: z.boolean(),
	updatedAt: z.string(),
});
export const todoPageSchema = z.object({
	rows: z.array(todoRowSchema),
	counts: z.object({
		todo: z.number().int().nonnegative(),
		archived: z.number().int().nonnegative(),
	}),
	total: z.number().int().nonnegative(),
	state: todoQuery.shape.state,
	pageIndex: z.number().int().nonnegative(),
	pageSize: todoQuery.shape.pageSize,
});
export type TodoPage = z.infer<typeof todoPageSchema>;
