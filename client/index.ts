import { agentRuntimeClient } from "./agent-runtime";
import { attitudeDatasetClient } from "./attitude-dataset";
import { conversationClient } from "./conversation";
import { dialogueClient } from "./dialogue";
import { eventsClient } from "./events";
import { larmClient } from "./larm";
import { memoryClient } from "./memory";
import { queueClient } from "./queue";
import { researchRoutesClient } from "./research-routes";
import { schedulerClient } from "./scheduler";
import { settingsClient } from "./settings";
import { serviceTestsClient } from "./service-tests";
import { ttsDictionaryClient } from "./tts-dictionary";
import { createTransport } from "./transport";
import { tasksClient } from "./tasks";
import { timersClient } from "./timers";
import { voiceDialogueClient } from "./voice-dialogue";
import { webResearchClient } from "./web-research";

export { ApiError, ApiConnectionError } from "./transport";
export function createClient(baseUrl: string, token?: string) {
	const transport = createTransport(baseUrl, token);
	return {
		...attitudeDatasetClient(transport),
		...eventsClient(transport),
		...conversationClient(transport),
		...dialogueClient(transport),
		...larmClient(transport),
		...settingsClient(transport),
		...serviceTestsClient(transport),
		...ttsDictionaryClient(transport),
		...memoryClient(transport),
		...queueClient(transport),
		...schedulerClient(transport),
		...voiceDialogueClient(transport),
		...webResearchClient(transport),
		...agentRuntimeClient(transport),
		...tasksClient(transport),
		...researchRoutesClient(transport),
		...timersClient(transport),
	};
}
export type EumenesClient = ReturnType<typeof createClient>;
