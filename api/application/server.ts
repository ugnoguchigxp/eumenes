import { dirname, join, resolve } from "node:path";
import { configureLogging, getLogger } from "../infrastructure/logger";
import { createConversationService } from "../domains/conversation";
import { createDialogueService } from "../domains/dialogue";
import { createSettings } from "../domains/settings";
import { createInference } from "../domains/inference";
import { createQueue } from "../domains/queue";
import { createScheduler } from "../domains/scheduler";
import { createVoiceDialogue } from "../domains/voice-dialogue";
import { createTtsDictionary } from "../domains/tts-dictionary";
import { createContinuityService } from "../domains/continuity";
import { createMemoryService } from "../domains/memory";
import { migrations } from "./migrations";
import { openStore } from "../infrastructure/sqlite";
import {
	resolveApiToken,
	resolveLarmToken,
} from "../infrastructure/auth-config";
import { createApp } from "./app";
import { createChanges } from "./events";
import { createServiceTests } from "../domains/service-tests";

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
	const host = process.env.EUMENES_HOST ?? "127.0.0.1";
	if (host !== "127.0.0.1" && host !== "localhost")
		throw new Error("loopback_host_required");
	const token = resolveApiToken(process.env);
	const store = openStore(dbPath, migrations);
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
	const serviceTests = createServiceTests(store, settings, larm, {
		token: resolveLarmToken(process.env),
	});
	const queue = createQueue(store, {
		resourceAliases: { "larm.llm": "inference.llm" },
	});
	const scheduler = createScheduler(store, queue);
	const continuity = createContinuityService(store);
	const memory = createMemoryService(store, conversation, continuity, {
		journalPath: resolve(
			process.env.EUMENES_MEMORY_JOURNAL ??
				join(dirname(dbPath), "memory-forget-journal.jsonl"),
		),
	});
	const dialogue = createDialogueService(
		store,
		conversation,
		larm,
		queue,
		undefined,
		undefined,
		memory,
	);
	const voice = createVoiceDialogue(store, dialogue, larm);
	scheduler.registerTarget(dialogue.promptTarget);
	// Recovery runs to completion before any worker starts; a failure aborts startup.
	log.info("server.recovery_started");
	// Journal reconciliation precedes any memory read or worker; a broken journal disables memory.
	const memoryRecovery = await memory.recover();
	if (!memoryRecovery.healthy)
		log.warn("memory.unavailable", { reason: memoryRecovery.reason });
	await voice.recover();
	await larm.recover();
	await serviceTests.recover();
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
		memory,
		continuity,
		changes,
		serviceTests,
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
			await serviceTests.close();
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
