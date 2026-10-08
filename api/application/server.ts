import { dirname, join } from "node:path";
import { configureLogging, getLogger } from "../infrastructure/logger";
import {
	migration as conversationMigration,
	avatarMotionMigration as conversationAvatarMotionMigration,
	answerDeliveryMigration as conversationAnswerDeliveryMigration,
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
import {
	createTtsDictionary,
	migration as ttsDictionaryMigration,
} from "../domains/tts-dictionary";
import { openStore } from "../infrastructure/sqlite";
import {
	resolveApiToken,
	resolveLarmToken,
} from "../infrastructure/auth-config";
import { createApp } from "./app";
import { createChanges } from "./events";

const dbPath = process.env.EUMENES_DB ?? "./data/eumenes.sqlite3";
configureLogging({
	file:
		process.env.EUMENES_LOG_FILE === "-"
			? undefined
			: process.env.EUMENES_LOG_FILE || join(dirname(dbPath), "logs/api.jsonl"),
	level: process.env.EUMENES_LOG_LEVEL,
});
const log = getLogger("server");
log.info("server.starting");
async function main() {
	// The continuity (bookmark) domain was removed. Migrations are applied by
	// position, so keep a no-op in its slot; its old tables are left untouched.
	const retiredContinuityMigration = "SELECT 1";
	const host = process.env.EUMENES_HOST ?? "127.0.0.1";
	if (host !== "127.0.0.1" && host !== "localhost")
		throw new Error("loopback_host_required");
	const token = resolveApiToken(process.env);
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
		ttsDictionaryMigration,
		conversationAvatarMotionMigration,
		conversationAnswerDeliveryMigration,
	]);
	const changes = createChanges();
	const unsubscribeCommits = store.onCommit(() => changes.publish());
	const conversation = createConversationService(store);
	const settings = await createSettings(store, { dbPath });
	const ttsDictionary = createTtsDictionary(store);
	const larm = createInference(store, settings, {
		token: resolveLarmToken(process.env),
		speechText: ttsDictionary.apply,
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
	log.info("server.recovery_started");
	await voice.recover();
	await larm.recover();
	await dialogue.recover();
	await queue.recover();
	await scheduler.recover();
	log.info("server.recovery_completed");
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
		ttsDictionary,
		changes,
	});
	const port = Number(process.env.EUMENES_PORT ?? 8787);
	const server = Bun.serve({
		hostname: host,
		port,
		idleTimeout: 60,
		fetch: app.fetch,
	});
	log.info("server.listening", { port: server.port });
	// Probe once so the UI reports a real result before the first message.
	void larm.connect().then(
		() => log.info("larm.probe_completed", { status: larm.status().state }),
		(error) =>
			log.warn("larm.probe_failed", { status: larm.status().state }, error),
	);
	let stopping: Promise<void> | null = null;
	function shutdown() {
		stopping ??= (async () => {
			log.info("server.shutdown_started");
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
			log.info("server.shutdown_completed");
		})();
		return stopping;
	}
	function terminate() {
		void shutdown().then(
			() => process.exit(0),
			(error) => {
				log.error(
					"server.shutdown_failed",
					{ reason: "shutdown_failed" },
					error,
				);
				process.exit(1);
			},
		);
	}
	process.on("SIGINT", terminate);
	process.on("SIGTERM", terminate);
}
await main().catch((error) => {
	const reason =
		error instanceof Error &&
		error.message ===
			"Set LARM_API_TOKEN or EUMENES_API_TOKEN before starting Eumenes"
			? "api_auth_unconfigured"
			: error instanceof Error &&
				  error.message === "EUMENES_API_TOKEN must be at least 24 characters"
				? "api_token_too_short"
				: error instanceof Error && error.message === "loopback_host_required"
					? "loopback_host_required"
					: "startup_failed";
	log.error("server.startup_failed", { reason }, error);
	process.exit(1);
});
