/**
 * The conversation agent of the offline evaluation: the agency's own reply loop and system text (spoken style, no
 * persona interests, no emotion), so the cases are read and answered the way the product's reply is, without a
 * settings database. The host's model call and tools come with each reply.
 */
import { respondSystemParts, runRespond } from "eumenes-agency";
import type { ConversationAgentPort } from "../../contracts";

export const evalConversationAgent: ConversationAgentPort = {
	system: () => respondSystemParts({ spoken: true }),
	async respond(input) {
		const reply = await runRespond({ ...input, emotion: false });
		return { text: reply.text, ended: reply.ended };
	},
};
