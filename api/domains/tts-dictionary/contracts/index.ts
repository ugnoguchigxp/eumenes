import { z } from "zod";
const noControl = (s: string) => ![...s].some((c) => /\p{Cc}/u.test(c));
// The speech chunker splits on these, so a headword containing one could never match.
const boundary = /[。！？、!?.,;]/u;
const text = z
	.string()
	.refine((s) => !/\p{Cs}/u.test(s) && s.trim() === s && noControl(s))
	// Compare in NFC so a decomposed headword matches the model's precomposed text.
	.transform((s) => s.normalize("NFC"));
export const entrySchema = z.strictObject({
	written: text.pipe(
		z
			.string()
			.min(1)
			.max(200)
			.refine((s) => !boundary.test(s)),
	),
	// An empty reading means "skip when speaking".
	spoken: text.pipe(z.string().max(400)),
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
