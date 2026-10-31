import { visualAnalysisClient } from "./visual-analysis";
import { doclingClient } from "./docling";
import { shellClient } from "./shell";
import { computeClient } from "./compute";
import { pipelinesClient } from "./pipelines";
import { googleAccountsClient } from "./google-accounts";
import { ocrClient } from "./ocr";
import { objectRecognitionClient } from "./object-recognition";
import { excalidrawClient } from "./excalidraw";
import { imageClient } from "./image";
import { musicClient } from "./music";
import { dotsClient } from "./dots";
import { requirementsClient } from "./requirements";
import { agentRuntimeClient } from "./agent-runtime";
import { attitudeDatasetClient } from "./attitude-dataset";
import { conversationClient } from "./conversation";
import { dialogueClient } from "./dialogue";
import { eventsClient } from "./events";
import { larmClient } from "./larm";
import { memoryClient } from "./memory";
import { monitoringClient } from "./monitoring";
import { toolchainHistoryClient } from "./toolchain-history";
import { settingsClient } from "./settings";
import { serviceTestsClient } from "./service-tests";
import { createTransport } from "./transport";
import { tasksClient } from "./tasks";
import { timersClient } from "./timers";
import { terminalsClient } from "./terminals";
import { kanbanClient } from "./kanban";
import { toolchainActionsClient } from "./toolchain-actions";
import { voiceDialogueClient } from "./voice-dialogue";
import { webResearchClient } from "./web-research";

export { ApiError, ApiConnectionError } from "./transport";
export { readSse } from "./sse";
export function createClient(baseUrl: string, token?: string) {
	const transport = createTransport(baseUrl, token);
	return {
		...doclingClient(transport),
		...computeClient(transport),
		...pipelinesClient(transport),
		...musicClient(transport),
		...imageClient(transport),
		...objectRecognitionClient(transport),
		...ocrClient(transport),
		...visualAnalysisClient(transport),
		...excalidrawClient(transport),
		...requirementsClient(transport),
		...dotsClient(transport),
		...attitudeDatasetClient(transport),
		...eventsClient(transport),
		...conversationClient(transport),
		...dialogueClient(transport),
		...larmClient(transport),
		...googleAccountsClient(transport),
		...settingsClient(transport),
		...serviceTestsClient(transport),
		...memoryClient(transport),
		...monitoringClient(transport),
		...voiceDialogueClient(transport),
		...webResearchClient(transport),
		...agentRuntimeClient(transport),
		...tasksClient(transport),
		...toolchainHistoryClient(transport),
		...timersClient(transport),
		...terminalsClient(transport),
		...shellClient(transport),
		...kanbanClient(transport),
		...toolchainActionsClient(transport),
	};
}
export type EumenesClient = ReturnType<typeof createClient>;
