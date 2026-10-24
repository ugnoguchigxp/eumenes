import { EVENT_SHARE_OF_LOG, headWithin } from "../../inference";
import type { DialogueDeps } from "./context";

/**
 * A text as one log event keeps (section 8.3): at most a tenth of the log's cap, its head when longer. The whole
 * text stays in the message the event refers to by its id.
 */
export function eventText(deps: Pick<DialogueDeps, "memory">, text: string) {
	const cap = deps.memory?.windowPlan().log.cap;
	return cap
		? headWithin(text, Math.floor(cap * EVENT_SHARE_OF_LOG)).text
		: text;
}
