import {
	migration as conversationMigration,
	createConversationService,
} from "../domains/conversation";
import {
	createContinuityService,
	migration as continuityMigration,
} from "../domains/continuity";
import {
	createDialogueService,
	migration as dialogueMigration,
	queueLinkMigration as dialogueQueueLinkMigration,
} from "../domains/dialogue";
import { createLarm } from "../domains/larm";
import { createQueue, migration as queueMigration } from "../domains/queue";
import {
	createScheduler,
	migration as schedulerMigration,
} from "../domains/scheduler";
import {
	createVoiceDialogue,
	migration as voiceMigration,
	sequenceMigration as voiceSequenceMigration,
} from "../domains/voice-dialogue";
import { openStore } from "../infrastructure/sqlite";
import {
	resolveApiToken,
	resolveLarmToken,
} from "../infrastructure/auth-config";
import { createApp } from "./app";

const host = process.env.EUMENES_HOST ?? "127.0.0.1";
if (host !== "127.0.0.1" && host !== "localhost")
	throw new Error("loopback_host_required");
const token = resolveApiToken(process.env);
const store = openStore(process.env.EUMENES_DB ?? "./data/eumenes.sqlite3", [
	conversationMigration,
	dialogueMigration,
	voiceMigration,
	// Appended migrations: never reorder or rewrite the ones above.
	queueMigration,
	schedulerMigration,
	dialogueQueueLinkMigration,
	voiceSequenceMigration,
	continuityMigration,
]);
const conversation = createConversationService(store);
const continuity = createContinuityService(store, conversation);
const larm = createLarm({
	baseUrl: process.env.LARM_BASE_URL,
	token: resolveLarmToken(process.env),
	profile: process.env.LARM_PROFILE,
	audience: process.env.LARM_AUDIENCE,
	voice: process.env.EUMENES_TTS_VOICE,
});
const queue = createQueue(store);
const scheduler = createScheduler(store, queue);
const dialogue = createDialogueService(store, conversation, larm, queue);
const voice = createVoiceDialogue(store, dialogue, larm);
scheduler.registerTarget(dialogue.promptTarget);
// Recovery runs to completion before any worker starts; a failure aborts startup.
await voice.recover();
await dialogue.recover();
await queue.recover();
await scheduler.recover();
queue.start();
scheduler.start();
const app = createApp({
	token,
	origin: process.env.EUMENES_ORIGIN ?? "http://127.0.0.1:5173",
	conversation,
	continuity,
	dialogue,
	voice,
	larm,
	queue,
	scheduler,
});
const port = Number(process.env.EUMENES_PORT ?? 8787);
const server = Bun.serve({ hostname: host, port, fetch: app.fetch });
console.log(`Eumenes API listening at http://${host}:${server.port}`);
let stopping: Promise<void> | null = null;
function shutdown() {
	stopping ??= (async () => {
		server.stop(true);
		await scheduler.close();
		await voice.close();
		await queue.close(10_000);
		await dialogue.close();
		await Promise.race([larm.close(), Bun.sleep(5_000)]);
		await store.close();
	})();
	return stopping;
}
function terminate() {
	void shutdown().then(
		() => process.exit(0),
		(error) => {
			console.error("shutdown_failed", error);
			process.exit(1);
		},
	);
}
process.on("SIGINT", terminate);
process.on("SIGTERM", terminate);
