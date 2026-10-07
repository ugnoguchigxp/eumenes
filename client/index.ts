import { conversationClient } from "./conversation";
import { continuityClient } from "./continuity";
import { dialogueClient } from "./dialogue";
import { larmClient } from "./larm";
import { queueClient } from "./queue";
import { schedulerClient } from "./scheduler";
import { createTransport } from "./transport";
import { voiceDialogueClient } from "./voice-dialogue";

export { ApiError } from "./transport";
export function createClient(baseUrl: string, token?: string) {
	const transport = createTransport(baseUrl, token);
	return {
		...conversationClient(transport),
		...continuityClient(transport),
		...dialogueClient(transport),
		...larmClient(transport),
		...queueClient(transport),
		...schedulerClient(transport),
		...voiceDialogueClient(transport),
	};
}
export type EumenesClient = ReturnType<typeof createClient>;
