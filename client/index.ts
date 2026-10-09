import { conversationClient } from "./conversation";
import { dialogueClient } from "./dialogue";
import { eventsClient } from "./events";
import { larmClient } from "./larm";
import { memoryClient } from "./memory";
import { queueClient } from "./queue";
import { schedulerClient } from "./scheduler";
import { settingsClient } from "./settings";
import { ttsDictionaryClient } from "./tts-dictionary";
import { createTransport } from "./transport";
import { voiceDialogueClient } from "./voice-dialogue";

export { ApiError, ApiConnectionError } from "./transport";
export function createClient(baseUrl: string, token?: string) {
	const transport = createTransport(baseUrl, token);
	return {
		...eventsClient(transport),
		...conversationClient(transport),
		...dialogueClient(transport),
		...larmClient(transport),
		...settingsClient(transport),
		...ttsDictionaryClient(transport),
		...memoryClient(transport),
		...queueClient(transport),
		...schedulerClient(transport),
		...voiceDialogueClient(transport),
	};
}
export type EumenesClient = ReturnType<typeof createClient>;
