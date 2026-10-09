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
	registerContinuity,
	type ContinuityService,
} from "../domains/continuity";
import { registerScheduler, type SchedulerService } from "../domains/scheduler";
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
import {
	registerServiceTests,
	type ServiceTests,
} from "../domains/service-tests";
export function createApp(deps: {
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
	continuity?: ContinuityService;
	changes?: Changes;
	serviceTests?: ServiceTests;
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
		if (c.req.header("authorization") !== `Bearer ${deps.token}`)
			return c.json({ error: "unauthorized" }, 401);
		await next();
	});
	if (deps.changes)
		app.get("/api/events", (c) => deps.changes!.open(c.req.raw.signal));
	registerLarmStatus(app, deps.larm);
	if (deps.settings) registerSettings(app, deps.settings);
	if (deps.inference) registerInference(app, deps.inference);
	if (deps.serviceTests) registerServiceTests(app, deps.serviceTests);
	if (deps.ttsDictionary) registerTtsDictionary(app, deps.ttsDictionary);
	if (deps.memory) registerMemory(app, deps.memory);
	if (deps.continuity) registerContinuity(app, deps.continuity);
	registerConversation(app, deps.conversation);
	registerDialogue(app, deps.dialogue);
	registerVoiceDialogue(app, deps.voice);
	registerQueue(app, deps.queue);
	registerScheduler(app, deps.scheduler);
	app.onError((error, c) => {
		const message = error instanceof Error ? error.message : "internal_error";
		const status =
			message === "request_conflict" ||
			message === "revision_conflict" ||
			message === "voice_sequence_out_of_order" ||
			message === "voice_utterance_conflict" ||
			message === "schedule_state_conflict" ||
			message === "memory_unavailable" ||
			message === "voice_preview_busy"
				? 409
				: message.startsWith("invalid_") ||
					  message === "voice_sequence_invalid" ||
					  message.startsWith("voice_session_") ||
					  message.startsWith("stale_")
					? 400
					: message === "database_writer_queue_full" ||
						  message === "queue_full" ||
						  message === "schedule_limit_reached" ||
						  message === "stream_capacity"
						? 503
						: 500;
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
