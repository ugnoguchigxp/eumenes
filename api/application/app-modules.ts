import {
	registerExcalidraw,
	type ExcalidrawService,
} from "../domains/excalidraw";
import {
	registerObjectRecognition,
	type ObjectRecognitionService,
} from "../domains/object-recognition";
import { CONVERSATION_DEFAULT_PRINCIPAL } from "../domains/conversation/contracts";
import { registerImage, type ImageService } from "../domains/image";
import { registerUiCompositions, type UiCompositionsService } from "../domains/ui-compositions";
import { registerMusic, type MusicService } from "../domains/music";
import {
	registerCodingSupervision,
	type CodingSupervision,
} from "../domains/coding-supervision";
import { registerTaskReports, type TaskReports } from "../domains/task-reports";
import {
	registerCapabilities,
	type Capabilities,
} from "../domains/capabilities";
import {
	registerAgentRuntime,
	type AgentRuntime,
} from "../domains/agent-runtime";
import {
	registerAttitudeDataset,
	type AttitudeDataset,
} from "../domains/attitude-dataset";
import type { Hono } from "hono";
import {
	type ConversationService,
	registerConversation,
} from "../domains/conversation";
import {
	type DialogueService,
	registerCommandInteractions,
	registerDialogue,
} from "../domains/dialogue";
import { type LarmPort, registerLarmStatus } from "../domains/larm";
import { type QueueService, registerQueue } from "../domains/queue";
import { registerMemory, type MemoryService } from "../domains/memory";
import {
	registerWebResearch,
	type WebResearchService,
} from "../domains/web-research";
import {
	registerContinuity,
	type ContinuityService,
} from "../domains/continuity";
import { registerScheduler, type SchedulerService } from "../domains/scheduler";
import { registerTimers, type TimersService } from "../domains/timers";
import {
	registerToolchainActions,
	type ActionRequests,
} from "../domains/tool-runtime";
import {
	registerVoiceDialogue,
	type VoiceDialogueService,
} from "../domains/voice-dialogue";
import { registerSettings, type SettingsService } from "../domains/settings";
import { registerInference, type InferenceService } from "../domains/inference";
import {
	registerTtsDictionary,
	type TtsDictionaryService,
} from "../domains/tts-dictionary";
import type { Changes } from "./events";
import { registerTasks, type TasksService } from "../domains/tasks";
import { registerCoding, type CodingService } from "../domains/coding";
import {
	registerToolchainHistory,
	type ToolchainHistory,
} from "../domains/toolchain-history";
import { registerWorldClaims } from "../domains/world";
import type { WorldClaims, WorldClaimsContext } from "../domains/world";
import {
	registerServiceTests,
	type ServiceTests,
} from "../domains/service-tests";

/** One independently mountable group of routes. Mounting order is registration order. */
export type AppModule = { mount(app: Hono): void };

/** The services a production or test composition may route to. Only the core five are mandatory. */
export type AppServices = {
	dotsModule?: AppModule;
	capabilities?: Capabilities;
	agents?: AgentRuntime;
	attitudeDataset?: AttitudeDataset;
	conversation: ConversationService;
	dialogue: DialogueService;
	voice: VoiceDialogueService;
	larm: Pick<LarmPort, "status" | "connect"> & Partial<LarmPort>;
	queue: QueueService;
	scheduler: SchedulerService;
	settings?: SettingsService;
	inference?: InferenceService;
	ttsDictionary?: TtsDictionaryService;
	memory?: MemoryService;
	webResearch?: WebResearchService;
	continuity?: ContinuityService;
	changes?: Changes;
	serviceTests?: ServiceTests;
	music?: MusicService;
	image?: ImageService;
	uiCompositions?: UiCompositionsService;
	excalidraw?: ExcalidrawService;
	drawingOperations?: { list: (conversationId: string) => unknown };
	objectRecognition?: ObjectRecognitionService;
	tasks?: TasksService;
	coding?: CodingService;
	codingSupervision?: CodingSupervision;
	taskReports?: TaskReports;
	toolchainHistory?: ToolchainHistory;
	timers?: TimersService;
	/** UI actions and artifact registrations of bound toolchains. */
	toolchainActions?: ActionRequests;
	/** World claim list and corrections (P5-02). Absent with World OFF: the routes do not exist. */
	worldClaims?: { claims: WorldClaims; context: () => WorldClaimsContext };
};

/**
 * The route modules for a set of services, in the order they are mounted (an
 * earlier module wins a path conflict). A service that is absent contributes
 * no module: with World OFF the claim routes do not exist.
 */
export function appModules(services: AppServices): AppModule[] {
	const s = services;
	const modules: Array<AppModule | undefined> = [
		s.changes && {
			mount: (app) =>
				app.get("/api/events", (c) =>
					s.changes!.open(c.req.raw.signal, c.req.header("last-event-id")),
				),
		},
		s.dotsModule,
		s.objectRecognition && {
			mount: (app) =>
				registerObjectRecognition(
					app,
					s.objectRecognition!,
					CONVERSATION_DEFAULT_PRINCIPAL,
					(text, conversationId, requestId) =>
						s.dialogue.submit({ text, conversationId, requestId }),
				),
		},
		s.excalidraw && {
			mount: (app) => {
				registerExcalidraw(app, s.excalidraw!);
				if (s.drawingOperations)
					app.get("/api/excalidraw/operations", (c) =>
						c.json(
							s.drawingOperations!.list(
								c.req.query("conversationId") ?? "main",
							),
						),
					);
			},
		},
		s.image && { mount: (app) => registerImage(app, s.image!) },
		s.uiCompositions && { mount: (app) => registerUiCompositions(app, s.uiCompositions!) },
		s.music && { mount: (app) => registerMusic(app, s.music!) },
		s.capabilities && {
			mount: (app) => registerCapabilities(app, s.capabilities!),
		},
		s.agents && {
			mount: (app) => registerAgentRuntime(app, s.agents!, s.dialogue.cancel),
		},
		s.attitudeDataset && {
			mount: (app) => registerAttitudeDataset(app, s.attitudeDataset!),
		},
		{ mount: (app) => registerLarmStatus(app, s.larm) },
		s.settings && { mount: (app) => registerSettings(app, s.settings!) },
		s.inference && { mount: (app) => registerInference(app, s.inference!) },
		s.serviceTests && {
			mount: (app) => registerServiceTests(app, s.serviceTests!),
		},
		s.tasks && { mount: (app) => registerTasks(app, s.tasks!) },
		s.coding && { mount: (app) => registerCoding(app, s.coding!) },
		s.codingSupervision && {
			mount: (app) => registerCodingSupervision(app, s.codingSupervision!),
		},
		s.taskReports && {
			mount: (app) => registerTaskReports(app, s.taskReports!),
		},
		s.toolchainHistory && {
			mount: (app) => registerToolchainHistory(app, s.toolchainHistory!),
		},
		s.ttsDictionary && {
			mount: (app) => registerTtsDictionary(app, s.ttsDictionary!),
		},
		s.memory && { mount: (app) => registerMemory(app, s.memory!) },
		s.webResearch && {
			mount: (app) => registerWebResearch(app, s.webResearch!),
		},
		s.continuity && {
			mount: (app) => registerContinuity(app, s.continuity!),
		},
		{ mount: (app) => registerConversation(app, s.conversation) },
		{ mount: (app) => registerDialogue(app, s.dialogue) },
		{ mount: (app) => registerCommandInteractions(app, s.dialogue) },
		{ mount: (app) => registerVoiceDialogue(app, s.voice) },
		{ mount: (app) => registerQueue(app, s.queue) },
		{ mount: (app) => registerScheduler(app, s.scheduler) },
		s.timers && { mount: (app) => registerTimers(app, s.timers!) },
		s.toolchainActions && {
			mount: (app) => registerToolchainActions(app, s.toolchainActions!),
		},
		s.worldClaims && {
			mount: (app) =>
				registerWorldClaims(app, s.worldClaims!.claims, s.worldClaims!.context),
		},
	];
	return modules.filter((module): module is AppModule => module !== undefined);
}
