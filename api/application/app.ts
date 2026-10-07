import { Hono } from "hono";
import {
	type ConversationService,
	registerConversation,
} from "../domains/conversation";
import {
	type ContinuityService,
	registerContinuity,
} from "../domains/continuity";
import { type DialogueService, registerDialogue } from "../domains/dialogue";
import { type LarmPort, registerLarmStatus } from "../domains/larm";
import { type QueueService, registerQueue } from "../domains/queue";
import { registerScheduler, type SchedulerService } from "../domains/scheduler";
import {
	registerVoiceDialogue,
	type VoiceDialogueService,
} from "../domains/voice-dialogue";
export function createApp(deps: {
	token: string;
	origin: string;
	conversation: ConversationService;
	continuity: ContinuityService;
	dialogue: DialogueService;
	voice: VoiceDialogueService;
	larm: LarmPort;
	queue: QueueService;
	scheduler: SchedulerService;
}) {
	const app = new Hono();
	app.use("/api/*", async (c, next) => {
		const origin = c.req.header("origin");
		if (origin && origin !== deps.origin)
			return c.json({ error: "origin_forbidden" }, 403);
		if (origin) {
			c.header("Access-Control-Allow-Origin", origin);
			c.header("Vary", "Origin");
			c.header(
				"Access-Control-Allow-Headers",
				"Authorization, Content-Type, X-Session-Id, X-Generation, X-Sequence, X-Utterance-Id",
			);
			c.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
		}
		if (c.req.method === "OPTIONS") return c.body(null, 204);
		if (c.req.header("authorization") !== `Bearer ${deps.token}`)
			return c.json({ error: "unauthorized" }, 401);
		await next();
	});
	registerLarmStatus(app, deps.larm);
	registerConversation(app, deps.conversation);
	registerContinuity(app, deps.continuity);
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
			message === "schedule_state_conflict"
				? 409
				: message.startsWith("invalid_") ||
					  message === "voice_sequence_invalid" ||
					  message.startsWith("voice_session_") ||
					  message.startsWith("stale_")
					? 400
					: message === "database_writer_queue_full" ||
						  message === "queue_full" ||
						  message === "schedule_limit_reached"
						? 503
						: 500;
		// Internal failures never leak details to the client.
		if (status === 500) {
			console.error(`internal_error: ${message}`);
			return c.json({ error: "internal_error" }, 500);
		}
		return c.json({ error: message }, status);
	});
	return app;
}
