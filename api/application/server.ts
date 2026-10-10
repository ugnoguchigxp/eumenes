import type { Database } from "bun:sqlite";
import { createCodingSupervision } from "../domains/coding-supervision";
import { createTaskReports } from "../domains/task-reports";
import {
	unavailableCodingWorkflow,
	superviseCodingExecution,
} from "./coding-supervision";
import { createToolchain } from "./toolchain";
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
import { createTimerAnnouncements } from "./timer-announcements";
import { createVoiceDialogue } from "../domains/voice-dialogue";
import { createTtsDictionary } from "../domains/tts-dictionary";
import { createContinuityService } from "../domains/continuity";
import { createMemoryService } from "../domains/memory";
import {
	createWebResearch,
	createWebCache,
	openWebCache,
} from "../domains/web-research";
import { legacyOrder, migrations } from "./migrations";
import { openStore } from "../infrastructure/sqlite";
import { resolveApiToken } from "../infrastructure/auth-config";
import { loadProcessConfig, type Config } from "../infrastructure/config";
import { createApp } from "./app";
import { appModules } from "./app-modules";
import {
	createLifecycleRunner,
	createTerminator,
	intervalLifecycle,
	type Lifecycle,
} from "./lifecycle";
import { createChanges } from "./events";
import { createServiceTests } from "../domains/service-tests";
import { createDelegatedTasks } from "./delegated-tasks";
import { createProductionCoding } from "./coding";
import { createCodingTaskExecution } from "./coding-tasks";
import {
	createWorldAssembly,
	defaultWorldJournalPath,
	resolveWorldCursorSecret,
} from "./world";
import { createWorldForeground } from "./world-foreground";

const log = getLogger("server");
/** Longest the whole shutdown may take before the process gives up and exits 1. */
const SHUTDOWN_DEADLINE_MS = 30_000;

/**
 * Constructs every service. Nothing is recovered, started or listening yet, and
 * the process environment is not read: all values come from `config`.
 */
export async function buildServices(config: Config) {
	const { dbPath } = config;
	const store = openStore(dbPath, migrations, { legacyOrder });
	const changes = createChanges();
	const unsubscribeCommits = store.onCommit(() => changes.publish());
	const conversation = createConversationService(store, {
		requireOutbox: true,
	});
	const settings = await createSettings(store, { dbPath, env: config.env });
	const ttsDictionary = createTtsDictionary(store);
	const datasetPath = resolve(config.attitudeDatasetPath);
	const datasetStore = openAttitudeStore(datasetPath);
	const attitudeDataset = createAttitudeDataset(datasetStore, datasetPath);
	await attitudeDataset.recover();
	const inference = createInference(store, settings, {
		token: config.larmToken,
		speechText: ttsDictionary.apply,
		attitudeDataset,
	});
	const unsubscribeStatus = inference.onChange(() => changes.publish());
	const serviceTests = createServiceTests(store, settings, inference, {
		token: config.larmToken,
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
	const timers = createTimers(
		store,
		{ scheduler, queue },
		{
			publish: () => changes.publish(),
			onElapsedInTransaction: createTimerAnnouncements(conversation),
		},
	);
	const codingComposition = config.codingRunnerConfig
		? await createProductionCoding(store, config.codingRunnerConfig)
		: undefined;
	const codingExecution = codingComposition
		? createCodingTaskExecution({
				store,
				coding: codingComposition.coding,
				tasks: () => delegated.tasks,
				available: codingComposition.available,
			})
		: undefined;
	const taskReports = createTaskReports({
		store,
		tasks: () => delegated.tasks,
	});
	const workflow = codingComposition
		? unavailableCodingWorkflow(store, codingComposition.coding)
		: undefined;
	const supervisedExecution =
		codingExecution && workflow
			? superviseCodingExecution({
					store,
					base: codingExecution.execution,
					tasks: () => delegated.tasks,
					supervision: () => supervision!,
					workflow,
				})
			: undefined;
	const delegated = createDelegatedTasks({
		store,
		queue,
		scheduler,
		enabled: config.delegatedTasksEnabled,
		execution: supervisedExecution,
		changedInTransaction: (db, t) =>
			supervision?.taskChangedInTransaction(db, t),
	});
	const supervision = workflow
		? createCodingSupervision({
				store,
				tasks: () => delegated.tasks,
				queue,
				inference,
				reports: taskReports,
				workflow,
				approveInstructions: () =>
					settings.get().codingSupervision.approveInstructions,
			})
		: undefined;
	const continuity = createContinuityService(store);
	const memoryJournalPath = resolve(config.memoryJournalPath);
	const memory = createMemoryService(store, conversation, continuity, {
		journalPath: memoryJournalPath,
	});
	// Foreground priority of Local extraction (P4-03): only with World ON.
	const worldForeground =
		config.worldMode === "on"
			? createWorldForeground({ store, queue, inference })
			: undefined;
	const world =
		config.worldMode === "off"
			? undefined
			: createWorldAssembly({
					store,
					conversation,
					memory,
					mode: config.worldMode,
					journalPath: resolve(
						config.worldJournalPath ??
							defaultWorldJournalPath(memoryJournalPath),
					),
					cursorSecret: resolveWorldCursorSecret({
						dbPath,
						env: { EUMENES_WORLD_CURSOR_SECRET: config.worldCursorSecret },
					}),
					// Local extraction exists only with World ON (P4-02).
					...(config.worldMode === "on"
						? {
								extraction: {
									queue,
									inference,
									...(worldForeground
										? { foreground: worldForeground.hub }
										: {}),
								},
							}
						: {}),
					...(config.worldPollMs ? { pollMs: config.worldPollMs } : {}),
				});
	const toolchain = await createToolchain(
		store,
		queue,
		inference,
		webResearch,
		{
			timers,
			conversation,
			history: config.historyToolsEnabled,
			webResearch: config.webResearchToolsEnabled,
		},
	);
	const enabled = config.toolchainEnabled;
	const dialogue = createDialogueService({
		store,
		conversation,
		larm: inference,
		queue,
		memory,
		agents: enabled ? toolchain.agents : undefined,
		postAnswer: enabled ? toolchain.postAnswer : undefined,
		...(world ? { worldContext: world.context } : {}),
	});
	const voice = createVoiceDialogue(store, dialogue, inference);
	scheduler.registerTarget(dialogue.promptTarget);
	const researchRoutes = toolchain.routeService
		? createOperations({
				routes: toolchain.routeService,
				store,
				skills: (db, id) =>
					toolchain.capabilities.getDefinitionInTransaction(db, id),
			})
		: undefined;
	return {
		store,
		changes,
		unsubscribeCommits,
		unsubscribeStatus,
		conversation,
		ttsDictionary,
		datasetStore,
		attitudeDataset,
		inference,
		serviceTests,
		queue,
		webResearch,
		scheduler,
		timers,
		codingComposition,
		codingExecution,
		taskReports,
		delegated,
		supervision,
		continuity,
		memory,
		settings,
		worldForeground,
		world,
		toolchain,
		dialogue,
		voice,
		researchRoutes,
	};
}
export type Services = Awaited<ReturnType<typeof buildServices>>;

function appServices(s: Services) {
	return {
		capabilities: s.toolchain.capabilities,
		agents: s.toolchain.agents,
		attitudeDataset: s.attitudeDataset,
		conversation: s.conversation,
		dialogue: s.dialogue,
		voice: s.voice,
		larm: s.inference,
		queue: s.queue,
		scheduler: s.scheduler,
		settings: s.settings,
		inference: s.inference,
		ttsDictionary: s.ttsDictionary,
		memory: s.memory,
		continuity: s.continuity,
		webResearch: s.webResearch,
		changes: s.changes,
		serviceTests: s.serviceTests,
		tasks: s.delegated.tasks,
		coding: s.codingComposition?.coding,
		codingSupervision: s.supervision,
		taskReports: s.taskReports,
		researchRoutes: s.researchRoutes,
		timers: s.timers,
		// With World OFF nothing is assembled and the routes do not exist.
		...(s.world
			? {
					worldClaims: {
						claims: s.world.claims,
						context: s.world.claimsContext,
					},
				}
			: {}),
	};
}

/**
 * Process lifecycle of the services. The three groups are separate because the
 * three orders differ: recovery order (a journal before the world that reads
 * it, queue before the tasks it carries), start order (runners after every
 * recovery), and bring-up order for resources, which `closeAll` walks in
 * reverse so the shutdown order is exactly: commit/status subscriptions,
 * change stream, HTTP, timers, coding, in-flight maintenance, world,
 * supervision, delegated, scheduler, service tests, voice, agents, queue,
 * web research, dialogue, inference, datasets, store.
 */
export function createLifecycles(s: Services, http: Lifecycle): Lifecycle[] {
	const routes = s.toolchain.routeService;
	const enqueueRouteSweep = (db: Database) =>
		void routes?.enqueueSweepInTransaction(db, { mode: "ttl" });
	const routeSweep = routes
		? intervalLifecycle(
				"route_sweep",
				3_600_000,
				() =>
					s.store
						.write((db) => enqueueRouteSweep(db))
						.catch((error) =>
							log.warn(
								"research_routes.sweep_enqueue_failed",
								{ reason: "enqueue_failed" },
								error,
							),
						),
				{ exclusive: false },
			)
		: undefined;
	const taskMaintenance = intervalLifecycle("task_maintenance", 60_000, () =>
		Promise.allSettled([
			s.supervision
				?.maintenance()
				.catch((error) =>
					log.warn(
						"coding_supervision.maintenance_failed",
						{ reason: "maintenance_failed" },
						error,
					),
				),
			s.delegated.tasks
				.maintenance()
				.catch((error) =>
					log.warn(
						"tasks.maintenance_failed",
						{ reason: "maintenance_failed" },
						error,
					),
				),
		]),
	);
	const codingHeartbeat = intervalLifecycle(
		"coding_heartbeat",
		15_000,
		() => s.codingExecution?.heartbeat(),
		{ exclusive: false },
	);
	const timerMaintenance = intervalLifecycle("timer_maintenance", 1000, () =>
		s.timers
			.maintenance()
			.catch((error) =>
				log.warn(
					"timers.maintenance_failed",
					{ reason: "maintenance_failed" },
					error,
				),
			),
	);
	let feedResyncRequired = false;
	return [
		// Recovery runs to completion before any worker starts; a failure aborts startup.
		{
			// Journal reconciliation precedes any memory read or worker; a broken journal disables memory.
			name: "memory_recovery",
			recover: async () => {
				const recovery = await s.memory.recover();
				if (!recovery.healthy)
					log.warn("memory.unavailable", { reason: recovery.reason });
				feedResyncRequired = recovery.feedResyncRequired === true;
			},
		},
		{
			// World recovery follows Memory's and precedes every queue/worker start. It never aborts startup:
			// a failed recovery leaves World's gate closed (fail closed) and is retried by its poll.
			name: "world_recovery",
			recover: async () => {
				await s.world?.recover({ feedResyncRequired });
			},
		},
		{ name: "voice_recovery", recover: () => s.voice.recover() },
		{ name: "inference_recovery", recover: () => s.inference.recover() },
		{ name: "service_tests_recovery", recover: () => s.serviceTests.recover() },
		{ name: "agents_recovery", recover: () => s.toolchain.agents.recover() },
		{ name: "dialogue_recovery", recover: () => s.dialogue.recover() },
		{ name: "web_research_recovery", recover: () => s.webResearch.recover() },
		{ name: "queue_recovery", recover: () => s.queue.recover() },
		{ name: "delegated_recovery", recover: () => s.delegated.recover() },
		{
			name: "coding_recovery",
			recover: async () => {
				await s.codingComposition?.coding.recover();
			},
		},
		{
			name: "supervision_recovery",
			recover: async () => {
				await s.supervision?.recover();
			},
		},
		{ name: "timers_recovery", recover: () => s.timers.recover() },
		{ name: "scheduler_recovery", recover: () => s.scheduler.recover() },
		// Route recovery (interrupt unfinished author/review drafts) precedes every runner.
		...(routes
			? [
					{
						name: "research_routes_recovery",
						recover: () =>
							s.store.write((db) => {
								routes.recoverInTransaction(db);
								enqueueRouteSweep(db);
							}),
					},
				]
			: []),
		// Start order. Change-feed/forget consumers: commit notification plus a modest poll; they never create inference jobs.
		...(routeSweep
			? [{ name: "route_sweep_start", start: () => routeSweep.start?.() }]
			: []),
		{ name: "agents_start", start: () => s.toolchain.agents.start() },
		{ name: "queue_start", start: () => s.queue.start() },
		{ name: "world_start", start: () => s.world?.start() },
		{ name: "web_research_start", start: () => s.webResearch.start() },
		{ name: "scheduler_start", start: () => s.scheduler.start() },
		{ name: "task_maintenance_start", start: () => taskMaintenance.start?.() },
		{ name: "coding_heartbeat_start", start: () => codingHeartbeat.start?.() },
		{
			name: "timer_maintenance_start",
			start: () => timerMaintenance.start?.(),
		},
		// Bring-up order of the resources; closed in reverse.
		{ name: "store", close: () => s.store.close() },
		{ name: "dataset_store", close: () => s.datasetStore.close() },
		{ name: "attitude_dataset", close: () => s.attitudeDataset.close() },
		{
			name: "inference",
			close: () => Promise.race([s.inference.close(), Bun.sleep(5_000)]),
		},
		{ name: "dialogue", close: () => s.dialogue.close() },
		{ name: "web_research", close: () => s.webResearch.close() },
		{ name: "queue", close: () => s.queue.close(10_000) },
		{ name: "capabilities", close: () => s.toolchain.capabilities.close() },
		{ name: "agents", close: () => s.toolchain.agents.close() },
		{ name: "voice", close: () => s.voice.close() },
		{ name: "service_tests", close: () => s.serviceTests.close() },
		{ name: "scheduler", close: () => s.scheduler.close() },
		{ name: "delegated", close: () => s.delegated.close() },
		{ name: "supervision", close: () => s.supervision?.close() },
		{ name: "world_foreground", close: () => s.worldForeground?.stop() },
		// World consumers stop before anything closes the store.
		{ name: "world", close: () => s.world?.close() },
		{ name: "task_maintenance", close: () => taskMaintenance.idle() },
		{ name: "timer_maintenance", close: () => timerMaintenance.idle() },
		// Worker lease also expires independently if shutdown cannot deliver a stop.
		{ name: "coding", close: () => s.codingComposition?.coding.close() },
		{ name: "coding_execution", close: () => s.codingExecution?.shutdown() },
		{
			name: "timers",
			close: () => {
				taskMaintenance.stop();
				codingHeartbeat.stop();
				timerMaintenance.stop();
				routeSweep?.stop();
			},
		},
		http,
		{ name: "changes", close: () => s.changes.close() },
		{ name: "status", close: () => s.unsubscribeStatus() },
		{ name: "commits", close: () => s.unsubscribeCommits() },
	];
}

async function main() {
	const config = loadProcessConfig();
	configureLogging({ file: config.logFile, level: config.logLevel });
	log.info("server.starting");
	if (config.host !== "127.0.0.1" && config.host !== "localhost")
		throw new Error("loopback_host_required");
	const token = resolveApiToken({
		EUMENES_API_TOKEN: config.apiToken,
		EUMENES_DB: config.dbPath,
		EUMENES_KEY_DIR: config.env.EUMENES_KEY_DIR,
	});
	const services = await buildServices(config);
	let server: ReturnType<typeof Bun.serve> | undefined;
	const runner = createLifecycleRunner(
		createLifecycles(services, {
			name: "http",
			close: () => server?.stop(true),
		}),
	);
	log.info("server.recovery_started");
	await runner.recoverAll();
	log.info("server.recovery_completed");
	runner.startAll();
	const app = createApp({
		token,
		origin: config.origin,
		modules: appModules(appServices(services)),
	});
	server = Bun.serve({
		hostname: config.host,
		port: config.port,
		idleTimeout: 60,
		fetch: app.fetch,
	});
	log.info("server.listening", { port: server.port });
	// Probe once so the UI reports a real result before the first message.
	void services.inference.connect().then(
		() =>
			log.info("larm.probe_completed", {
				status: services.inference.status().state,
			}),
		(error) =>
			log.warn(
				"larm.probe_failed",
				{ status: services.inference.status().state },
				error,
			),
	);
	// Resolves to true when every step succeeded. A failing step never skips the later ones.
	let stopping: Promise<boolean> | null = null;
	const shutdown = () =>
		(stopping ??= (async () => {
			log.info("server.shutdown_started");
			const ok = await runner.closeAll(SHUTDOWN_DEADLINE_MS);
			log.info("server.shutdown_completed", { reason: ok ? "ok" : "failed" });
			return ok;
		})());
	// The process-level deadline backs up the runner's own, which normally fires first.
	const terminate = createTerminator({
		shutdown,
		exit: (code) => process.exit(code),
		log,
		deadlineMs: SHUTDOWN_DEADLINE_MS + 5_000,
	});
	process.on("SIGINT", terminate);
	process.on("SIGTERM", terminate);
}

/** The stable, non-sensitive reason code of a startup failure. */
export function startupFailureReason(error: unknown): string {
	const message = error instanceof Error ? error.message : undefined;
	if (message && /^config_invalid:[A-Z0-9_]+$/.test(message)) return message;
	return message === "api_token_file_invalid"
		? "api_token_file_invalid"
		: message === "EUMENES_API_TOKEN must be at least 24 characters"
			? "api_token_too_short"
			: message === "loopback_host_required"
				? "loopback_host_required"
				: "startup_failed";
}

// Importing this module only defines functions; the process starts when it is the entry point.
if (import.meta.main) {
	await main().catch((error) => {
		log.error(
			"server.startup_failed",
			{ reason: startupFailureReason(error) },
			error,
		);
		process.exit(1);
	});
}
