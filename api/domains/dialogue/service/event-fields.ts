import type { ConversationEvent } from "../../continuity";

/** The fields of a logged event as the model reads them; empty once moved out or forgotten. */
export function eventFields(event: ConversationEvent): Record<string, unknown> {
	if (!event.text) return {};
	try {
		const parsed = JSON.parse(event.text) as unknown;
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}

/** The actions a generation commits (section 13): what the conversation can no longer take back. */
export const SIDE_EFFECTS = new Set([
	"memory.request",
	"delegate",
	"confirm",
	"work.answer",
	"work.amend",
	"work.cancel",
]);

export type Heard = "full" | "partial" | "none";

/** How much of an utterance reached the user: its newest `delivered` record in the log, or null while none. */
export function heardOf(
	log: readonly ConversationEvent[],
	saidId: string,
): Heard | null {
	for (let i = log.length - 1; i >= 0; i--) {
		const event = log[i]!;
		if (event.type !== "delivered") continue;
		const fields = eventFields(event);
		if (fields.ref !== saidId) continue;
		return fields.heard === "full" || fields.heard === "partial"
			? fields.heard
			: "none";
	}
	return null;
}
