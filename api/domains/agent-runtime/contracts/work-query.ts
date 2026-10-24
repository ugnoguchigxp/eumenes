import { z } from "zod";

/** Read-only display parameters; independent of the agency's bounded context list. */
export const workQuery = z.object({
	state: z.enum(["active", "todo", "done", "archived"]),
	pageIndex: z.coerce.number().int().min(0).max(1_000_000).default(0),
	pageSize: z.coerce
		.number()
		.pipe(z.union([z.literal(10), z.literal(25), z.literal(50)]))
		.default(10),
});
export type WorkQuery = z.infer<typeof workQuery>;
export const workSourceQuery = workQuery.extend({
	conversationId: z.string().min(1).max(120),
});
