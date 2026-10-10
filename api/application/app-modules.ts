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
import { type DialogueService, registerDialogue } from "../domains/dialogue";
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
	registerResearchRoutes,
	type RouteOperations,
} from "../domains/research-routes";
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
	tasks?: TasksService;
	coding?: CodingService;
	codingSupervision?: CodingSupervision;
	taskReports?: TaskReports;
	researchRoutes?: RouteOperations;
	timers?: TimersService;
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
				app.get("/api/events", (c) => s.changes!.open(c.req.raw.signal)),
		},
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
		s.researchRoutes && {
			mount: (app) => registerResearchRoutes(app, s.researchRoutes!),
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
		{ mount: (app) => registerVoiceDialogue(app, s.voice) },
		{ mount: (app) => registerQueue(app, s.queue) },
		{ mount: (app) => registerScheduler(app, s.scheduler) },
		s.timers && { mount: (app) => registerTimers(app, s.timers!) },
		s.worldClaims && {
			mount: (app) =>
				registerWorldClaims(app, s.worldClaims!.claims, s.worldClaims!.context),
		},
	];
	return modules.filter((module): module is AppModule => module !== undefined);
}
