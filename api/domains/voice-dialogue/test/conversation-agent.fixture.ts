import { runRespond } from "eumenes-agency";
import type { ConversationAgentPort } from "../../dialogue";

/**
 * The conversation agent of the voice tests: the agency's own reply loop (the host's model call and tools, no
 * emotion), with no system text of its own, so a scripted model sees the host's prompt as it is.
 */
export const testConversationAgent: ConversationAgentPort = {
	system: () => "",
	async respond(input) {
		const reply = await runRespond({ ...input, emotion: false });
		return { text: reply.text, ended: reply.ended };
	},
};
