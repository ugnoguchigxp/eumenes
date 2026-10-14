import { z } from "zod";
const conversationId = z.string().min(1).max(128).default("main");
const referenceSchema = z.strictObject({
	kind: z.literal("reference"),
	referenceId: z.uuid(),
	revision: z.coerce
		.number()
		.int()
		.positive()
		.max(Number.MAX_SAFE_INTEGER)
		.optional(),
	conversationId,
});
const draftSchema = z.strictObject({
	kind: z.literal("new"),
	draftId: z.uuid(),
	title: z.string().min(1).max(200).default("新しい図"),
	conversationId,
});
export type DrawingLocation =
	| z.infer<typeof referenceSchema>
	| z.infer<typeof draftSchema>;
/** The link carries reference context; the backend still enforces its conversation. */
export function drawingLocation(hash: string): DrawingLocation | null {
	const match = /^#drawing\/(new\/)?([^/?]+)(?:\?(.*))?$/.exec(hash);
	if (!match) return null;
	const draft = !!match[1];
	const allowed = draft
		? ["title", "conversationId"]
		: ["revision", "conversationId"];
	const query = new URLSearchParams(match[3]);
	if (
		[...query.keys()].some(
			(key) => !allowed.includes(key) || query.getAll(key).length !== 1,
		)
	)
		return null;
	const context = Object.fromEntries(query);
	const parsed = draft
		? draftSchema.safeParse({ kind: "new", draftId: match[2], ...context })
		: referenceSchema.safeParse({
				kind: "reference",
				referenceId: match[2],
				...context,
			});
	return parsed.success ? parsed.data : null;
}
/** The id an editor reports for itself: its saved reference, or its unsaved draft. */
export const drawingFrameId = (location: DrawingLocation) =>
	location.kind === "reference" ? location.referenceId : location.draftId;
export function draftDrawingHash(conversationId = "main") {
	return `#drawing/new/${crypto.randomUUID()}${conversationId === "main" ? "" : `?${new URLSearchParams({ conversationId })}`}`;
}
