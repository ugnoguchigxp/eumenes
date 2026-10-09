import { createToolchain, toolchainEnabled } from "./toolchain";
import { createOperations } from "../domains/research-routes";
import {
	createAttitudeDataset,
	openAttitudeStore,
} from "../domains/attitude-dataset";
import { dirname, join, resolve } from "node:path";
import { configureLogging, getLogger } from "../infrastructure/logger";
import { createConversationService } from "../domains/conversation";
import { createDialogueService } from "../domains/dialogue";
import { createSettings } from "../domains/settings";
import { createInference } from "../domains/inference";
import { createQueue } from "../domains/queue";
import { createScheduler } from "../domains/scheduler";
import { createTimers } from "../domains/timers";
import { createVoiceDialogue } from "../domains/voice-dialogue";
import { createTtsDictionary } from "../domains/tts-dictionary";
import { createContinuityService } from "../domains/continuity";
import { createMemoryService } from "../domains/memory";
import {
	createWebResearch,
	createWebCache,
	openWebCache,
} from "../domains/web-research";
import { migrations } from "./migrations";
import { openStore } from "../infrastructure/sqlite";
import {
	resolveApiToken,
	resolveLarmToken,
} from "../infrastructure/auth-config";
import { createApp } from "./app";
import { createChanges } from "./events";
import { createServiceTests } from "../domains/service-tests";
import { createDelegatedTasks, delegatedTasksEnabled } from "./delegated-tasks";

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
/** Production wiring: every dependency is mandatory (tests may still assemble a partial createApp). */
function createProductionApp(
	deps: Required<Omit<Parameters<typeof createApp>[0], "researchRoutes">> &
		Pick<Parameters<typeof createApp>[0], "researchRoutes">,
) {
	return createApp(deps);
}
async function main() {
	const host = process.env.EUMENES_HOST ?? "127.0.0.1";
	if (host !== "127.0.0.1" && host !== "localhost")
		throw new Error("loopback_host_required");
	const token = resolveApiToken(process.env);
	const store = openStore(dbPath, migrations);
	const changes = createChanges();
	const unsubscribeCommits = store.onCommit(() => changes.publish());
	const conversation = createConversationService(store, {
		requireOutbox: true,
	});
	const settings = await createSettings(store, { dbPath });
	const ttsDictionary = createTtsDictionary(store);
	const datasetPath = resolve(
		process.env.EUMENES_ATTITUDE_DATASET ??
			join(dirname(dbPath), "attitude-dataset/dataset.sqlite3"),
	);
	const datasetStore = openAttitudeStore(datasetPath);
	const attitudeDataset = createAttitudeDataset(datasetStore, datasetPath);
	await attitudeDataset.recover();
	const inference = createInference(store, settings, {
		token: resolveLarmToken(process.env),
		speechText: ttsDictionary.apply,
		attitudeDataset,
	});
	const unsubscribeStatus = inference.onChange(() => changes.publish());
	const serviceTests = createServiceTests(store, settings, inference, {
		token: resolveLarmToken(process.env),
	});
	const queue = createQueue(store, {
		resourceAliases: { "larm.llm": "inference.llm" },
		resources: { "inference.llm": 1, "web.fetch": 2 },
	});
	const cachePath = resolve(
		join(dirname(dbPath), "cache/web-research.sqlite3"),
	);
	let webCache: ReturnType<typeof createWebCache> | undefined;
	try {
		webCache = createWebCache(openWebCache(cachePath), { path: cachePath });
	} catch {
		log.warn("web.cache_unavailable", { reason: "cache_open_failed" });
	}
	const webResearch = createWebResearch({ store, queue, cache: webCache });
	const scheduler = createScheduler(store, queue);
	const timers = createTimers(store, { scheduler, queue }, {
		publish: () => changes.publish(),
	});
	const delegated = createDelegatedTasks({
		store,
		queue,
		scheduler,
		enabled: delegatedTasksEnabled(),
	});
	const continuity = createContinuityService(store);
	const memory = createMemoryService(store, conversation, continuity, {
		journalPath: resolve(
			process.env.EUMENES_MEMORY_JOURNAL ??
				join(dirname(dbPath), "memory-forget-journal.jsonl"),
		),
	});
	const toolchain = await createToolchain(store, queue, inference, webResearch);
	const enabled = toolchainEnabled();
	const dialogue = createDialogueService({
		store,
		conversation,
		larm: inference,
		queue,
		memory,
		agents: enabled ? toolchain.agents : undefined,
		postAnswer: enabled ? toolchain.postAnswer : undefined,
	});
	const voice = createVoiceDialogue(store, dialogue, inference);
	scheduler.registerTarget(dialogue.promptTarget);
	// Recovery runs to completion before any worker starts; a failure aborts startup.
	log.info("server.recovery_started");
	// Journal reconciliation precedes any memory read or worker; a broken journal disables memory.
	const memoryRecovery = await memory.recover();
	if (!memoryRecovery.healthy)
		log.warn("memory.unavailable", { reason: memoryRecovery.reason });
	await voice.recover();
	await inference.recover();
	await serviceTests.recover();
	await toolchain.agents.recover();
	await dialogue.recover();
	await webResearch.recover();
	await queue.recover();
	await delegated.recover();
	await timers.recover();
	await scheduler.recover();
	log.info("server.recovery_completed");
	// Route recovery (interrupt unfinished author/review drafts) precedes every runner.
	const routeOps = toolchain.routeService
		? createOperations({
				routes: toolchain.routeService,
				store,
				skills: (db, id) =>
					toolchain.capabilities.getDefinitionInTransaction(db, id),
			})
		: undefined;
	let routeSweep: ReturnType<typeof setInterval> | undefined;
	if (toolchain.routeService) {
		const routes = toolchain.routeService;
		await store.write((db) => {
			routes.recoverInTransaction(db);
			routes.enqueueSweepInTransaction(db, { mode: "ttl" });
		});
		routeSweep = setInterval(() => {
			void store
				.write((db) => routes.enqueueSweepInTransaction(db, { mode: "ttl" }))
				.catch((error) =>
					log.warn(
						"research_routes.sweep_enqueue_failed",
						{ reason: "enqueue_failed" },
						error,
					),
				);
		}, 3_600_000);
		routeSweep.unref();
	}
	toolchain.agents.start();
	queue.start();
	webResearch.start();
	scheduler.start();
	const taskMaintenance = setInterval(() => {
		void delegated.tasks
			.maintenance()
			.catch((error) =>
				log.warn(
					"tasks.maintenance_failed",
					{ reason: "maintenance_failed" },
					error,
				),
			);
	}, 60_000);
	taskMaintenance.unref();
	let timerMaintenanceBusy: Promise<unknown> | null = null;
	const timerMaintenance = setInterval(() => {
		if (timerMaintenanceBusy) return;
		timerMaintenanceBusy = timers
			.maintenance()
			.catch((error) =>
				log.warn(
					"timers.maintenance_failed",
					{ reason: "maintenance_failed" },
					error,
				),
			)
			.finally(() => {
				timerMaintenanceBusy = null;
			});
	}, 1000);
	timerMaintenance.unref();
	const app = createProductionApp({
		capabilities: toolchain.capabilities,
		agents: toolchain.agents,
		attitudeDataset,
		token,
		origin: process.env.EUMENES_ORIGIN ?? "http://127.0.0.1:5173",
		conversation,
		dialogue,
		voice,
		larm: inference,
		queue,
		scheduler,
		settings,
		inference,
		ttsDictionary,
		memory,
		continuity,
		webResearch,
		changes,
		serviceTests,
		tasks: delegated.tasks,
		researchRoutes: routeOps,
		timers,
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
	void inference.connect().then(
		() =>
			log.info("larm.probe_completed", { status: inference.status().state }),
		(error) =>
			log.warn(
				"larm.probe_failed",
				{ status: inference.status().state },
				error,
			),
	);
	let stopping: Promise<void> | null = null;
	function shutdown() {
		stopping ??= (async () => {
			log.info("server.shutdown_started");
			unsubscribeCommits();
			unsubscribeStatus();
			changes.close();
			server.stop(true);
			clearInterval(taskMaintenance);
			clearInterval(timerMaintenance);
			await timerMaintenanceBusy;
			delegated.close();
			await scheduler.close();
			await serviceTests.close();
			await voice.close();
			await toolchain.agents.close();
			toolchain.capabilities.close();
			await queue.close(10_000);
			await webResearch.close();
			await dialogue.close();
			await Promise.race([inference.close(), Bun.sleep(5_000)]);
			await attitudeDataset.close();
			await datasetStore.close();
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
