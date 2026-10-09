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
import { getLogger, withLogContext } from "../infrastructure/logger";
import { Hono } from "hono";
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
import { statusForError } from "./error-status";
import { registerTasks, type TasksService } from "../domains/tasks";
import { registerCoding, type CodingService } from "../domains/coding";
import {
	registerResearchRoutes,
	type RouteOperations,
} from "../domains/research-routes";
import { registerWorldClaims } from "../domains/world";
import type { WorldClaims, WorldClaimsContext } from "../domains/world";
import { createHash, timingSafeEqual } from "node:crypto";
import {
	registerServiceTests,
	type ServiceTests,
} from "../domains/service-tests";
const digest = (value: string) => createHash("sha256").update(value).digest();
const safeEqual = (a: string, b: string) =>
	timingSafeEqual(digest(a), digest(b));
const maxJsonBytes = 1024 * 1024;
// Audio uploads are bounded by their own streaming reader (4MB).
const isAudioUpload = (path: string) =>
	path === "/api/voice/turns" || path === "/api/voice/preview";

export function createApp(deps: {
	capabilities?: Capabilities;
	agents?: AgentRuntime;
	attitudeDataset?: AttitudeDataset;
	token: string;
	origin: string;
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
}) {
	const app = new Hono();
	const log = getLogger("http");
	app.use("/api/*", async (c, next) => {
		const requestId = crypto.randomUUID();
		const started = performance.now();
		c.header("X-Request-Id", requestId);
		return withLogContext({ httpRequestId: requestId }, async () => {
			log.debug("http.started", { method: c.req.method });
			await next();
			const fields = {
				method: c.req.method,
				route: c.req.routePath,
				status: c.res.status,
				durationMs: Math.round(performance.now() - started),
			};
			if (c.res.status >= 500) log.error("http.completed", fields);
			else if (c.res.status >= 400) log.warn("http.completed", fields);
			else if (c.req.method === "GET") log.debug("http.completed", fields);
			else log.info("http.completed", fields);
		});
	});
	app.use("/api/*", async (c, next) => {
		const origin = c.req.header("origin");
		if (origin && origin !== deps.origin)
			return c.json({ error: "origin_forbidden" }, 403);
		if (origin) {
			c.header("Access-Control-Allow-Origin", origin);
			c.header("Vary", "Origin");
			c.header("Access-Control-Expose-Headers", "X-Request-Id");
			c.header(
				"Access-Control-Allow-Headers",
				"Authorization, Content-Type, Last-Event-ID, X-Session-Id, X-Generation, X-Sequence, X-Utterance-Id",
			);
			c.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
		}
		if (c.req.method === "OPTIONS") return c.body(null, 204);
		if (!safeEqual(c.req.header("authorization") ?? "", `Bearer ${deps.token}`))
			return c.json({ error: "unauthorized" }, 401);
		if (
			c.req.method !== "GET" &&
			c.req.method !== "HEAD" &&
			!isAudioUpload(c.req.path)
		) {
			const length = c.req.header("content-length");
			if (length === undefined) {
				if (c.req.header("transfer-encoding"))
					return c.json({ error: "length_required" }, 411);
			} else if (!(Number(length) <= maxJsonBytes))
				return c.json({ error: "payload_too_large" }, 413);
		}
		await next();
	});
	if (deps.changes)
		app.get("/api/events", (c) => deps.changes!.open(c.req.raw.signal));
	if (deps.capabilities) registerCapabilities(app, deps.capabilities);
	if (deps.agents) registerAgentRuntime(app, deps.agents, deps.dialogue.cancel);
	if (deps.attitudeDataset) registerAttitudeDataset(app, deps.attitudeDataset);
	registerLarmStatus(app, deps.larm);
	if (deps.settings) registerSettings(app, deps.settings);
	if (deps.inference) registerInference(app, deps.inference);
	if (deps.serviceTests) registerServiceTests(app, deps.serviceTests);
	if (deps.tasks) registerTasks(app, deps.tasks);
	if (deps.coding) registerCoding(app, deps.coding);
	if (deps.codingSupervision)
		registerCodingSupervision(app, deps.codingSupervision);
	if (deps.taskReports) registerTaskReports(app, deps.taskReports);
	if (deps.researchRoutes) registerResearchRoutes(app, deps.researchRoutes);
	if (deps.ttsDictionary) registerTtsDictionary(app, deps.ttsDictionary);
	if (deps.memory) registerMemory(app, deps.memory);
	if (deps.webResearch) registerWebResearch(app, deps.webResearch);
	if (deps.continuity) registerContinuity(app, deps.continuity);
	registerConversation(app, deps.conversation);
	registerDialogue(app, deps.dialogue);
	registerVoiceDialogue(app, deps.voice);
	registerQueue(app, deps.queue);
	registerScheduler(app, deps.scheduler);
	if (deps.timers) registerTimers(app, deps.timers);
	if (deps.worldClaims)
		registerWorldClaims(app, deps.worldClaims.claims, deps.worldClaims.context);
	app.onError((error, c) => {
		const message = error instanceof Error ? error.message : "internal_error";
		const status = statusForError(message);
		// Internal failures never leak details to the client.
		if (status === 500) {
			log.error("http.failed", { reason: "internal_error", status }, error);
			return c.json({ error: "internal_error" }, 500);
		}
		log.warn("http.rejected", { reason: message, status });
		return c.json({ error: message }, status);
	});
	return app;
}
