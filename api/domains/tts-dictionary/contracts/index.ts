import { z } from "zod";
const noControl = (s: string) => ![...s].some((c) => /\p{Cc}/u.test(c));
export const entrySchema = z.strictObject({
	written: z
		.string()
		.min(1)
		.max(200)
		.refine((s) => s.trim() === s && noControl(s)),
	// An empty reading means "skip when speaking".
	spoken: z
		.string()
		.max(400)
		.refine((s) => s.trim() === s && noControl(s)),
});
export type Entry = z.infer<typeof entrySchema>;
// The wrapper distinguishes "no guard" from "row must not exist".
const expectedSchema = z.strictObject({ spoken: z.string().nullable() });
export const saveSchema = z.strictObject({
	original: z.string().max(200).nullable(),
	entry: entrySchema,
	expected: expectedSchema,
});
export const deleteSchema = z.strictObject({
	written: z.string().min(1).max(200),
	expected: expectedSchema,
});
export type SaveInput = z.infer<typeof saveSchema>;
export type DeleteInput = z.infer<typeof deleteSchema>;
export const entriesSchema = z.object({ entries: z.array(entrySchema) });
