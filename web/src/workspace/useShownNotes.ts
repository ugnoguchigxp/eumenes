import { useEffect, useRef } from "react";
import type { ConversationResourcesResponse } from "../../../api/domains/resources/contracts";

/** The message that carries a note the agency shows (its document is the message's resource). */
const isShownNote = (id: string) => id.startsWith("agency-note:");

/**
 * A note the agency shows opens in its document's screen (the Markdown view) when its message arrives. The ones
 * already in the conversation when the screen opened stay closed: the chip of the message opens them.
 */
export function useShownNotes(
	messages: ReadonlyArray<{ id: string }> | undefined,
	resources: ConversationResourcesResponse | undefined,
	open: (uri: string) => unknown,
) {
	const seen = useRef<Set<string> | null>(null);
	useEffect(() => {
		if (!messages) return;
		const notes = messages.map((m) => m.id).filter(isShownNote);
		if (!seen.current) {
			seen.current = new Set(notes);
			return;
		}
		for (const id of notes) {
			if (seen.current.has(id)) continue;
			// The message may arrive before the list of resources does: looked at again when it changes.
			const uri = resources?.messages.find((m) => m.messageId === id)?.uris[0];
			if (!uri) continue;
			seen.current.add(id);
			open(uri);
		}
	}, [messages, resources, open]);
}
