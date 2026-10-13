import { z } from "zod";
const locationSchema = z.strictObject({
	referenceId: z.uuid(),
	revision: z.coerce
		.number()
		.int()
		.positive()
		.max(Number.MAX_SAFE_INTEGER)
		.optional(),
	conversationId: z.string().min(1).max(128).default("main"),
});
/** The link carries reference context; the backend still enforces its conversation. */
export function drawingLocation(hash: string) {
	const match = /^#drawing\/([^?]+)(?:\?(.*))?$/.exec(hash);
	if (!match) return null;
	const query = new URLSearchParams(match[2]);
	if (
		[...query.keys()].some(
			(key) =>
				!["revision", "conversationId"].includes(key) ||
				query.getAll(key).length !== 1,
		)
	)
		return null;
	const parsed = locationSchema.safeParse({
		referenceId: match[1],
		...(query.has("revision") ? { revision: query.get("revision") } : {}),
		...(query.has("conversationId")
			? { conversationId: query.get("conversationId") }
			: {}),
	});
	return parsed.success ? parsed.data : null;
}
