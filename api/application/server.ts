import {
	migration as conversationMigration,
	createConversationService,
} from "../domains/conversation";
import {
	createDialogueService,
	migration as dialogueMigration,
	queueLinkMigration as dialogueQueueLinkMigration,
} from "../domains/dialogue";
import {
	createSettings,
	migration as settingsMigration,
	epochsMigration as settingsEpochsMigration,
} from "../domains/settings";
import {
	createInference,
	migration as inferenceMigration,
	parentsMigration as inferenceParentsMigration,
	diagnosticsMigration as inferenceDiagnosticsMigration,
} from "../domains/inference";
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
import { createChanges } from "./events";

// The continuity (bookmark) domain was removed. Migrations are applied by
// position, so keep a no-op in its slot; its old tables are left untouched.
const retiredContinuityMigration = "SELECT 1";
const host = process.env.EUMENES_HOST ?? "127.0.0.1";
if (host !== "127.0.0.1" && host !== "localhost")
	throw new Error("loopback_host_required");
const token = resolveApiToken(process.env);
const dbPath = process.env.EUMENES_DB ?? "./data/eumenes.sqlite3";
const store = openStore(dbPath, [
	conversationMigration,
	dialogueMigration,
	voiceMigration,
	// Appended migrations: never reorder or rewrite the ones above.
	queueMigration,
	schedulerMigration,
	dialogueQueueLinkMigration,
	voiceSequenceMigration,
	retiredContinuityMigration,
	settingsMigration,
	inferenceMigration,
	settingsEpochsMigration,
	inferenceParentsMigration,
	inferenceDiagnosticsMigration,
]);
const changes = createChanges();
const unsubscribeCommits = store.onCommit(() => changes.publish());
const conversation = createConversationService(store);
const settings = await createSettings(store, { dbPath });
const larm = createInference(store, settings, {
	token: resolveLarmToken(process.env),
});
const unsubscribeStatus = larm.onChange(() => changes.publish());
const queue = createQueue(store, {
	resourceAliases: { "larm.llm": "inference.llm" },
});
const scheduler = createScheduler(store, queue);
const dialogue = createDialogueService(store, conversation, larm, queue);
const voice = createVoiceDialogue(store, dialogue, larm);
scheduler.registerTarget(dialogue.promptTarget);
// Recovery runs to completion before any worker starts; a failure aborts startup.
await voice.recover();
await larm.recover();
await dialogue.recover();
await queue.recover();
await scheduler.recover();
queue.start();
scheduler.start();
const app = createApp({
	token,
	origin: process.env.EUMENES_ORIGIN ?? "http://127.0.0.1:5173",
	conversation,
	dialogue,
	voice,
	larm,
	queue,
	scheduler,
	settings,
	inference: larm,
	changes,
});
const port = Number(process.env.EUMENES_PORT ?? 8787);
const server = Bun.serve({
	hostname: host,
	port,
	idleTimeout: 60,
	fetch: app.fetch,
});
console.log(`Eumenes API listening at http://${host}:${server.port}`);
// Probe once so the UI reports a real result before the first message.
void larm.connect().catch(() => {
	console.error(
		`LARM connection failed: ${larm.status().error ?? "unconfigured"}`,
	);
});
let stopping: Promise<void> | null = null;
function shutdown() {
	stopping ??= (async () => {
		unsubscribeCommits();
		unsubscribeStatus();
		changes.close();
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
