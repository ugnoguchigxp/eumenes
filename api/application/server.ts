import {
	createGoogleAccounts,
	googleProviderFromEnv,
	type GoogleProvider,
} from "../domains/google-accounts";
import { createOcr } from "../domains/ocr";
import {
	createExcalidraw,
	registerDrawingOperations,
} from "../domains/excalidraw";
import { createLocalServices } from "../domains/larm";
import { createObjectRecognition } from "../domains/object-recognition";
import { CONVERSATION_DEFAULT_PRINCIPAL } from "../domains/conversation/contracts";
import { createTaskReportDelivery } from "./task-report-delivery";
import { createDotsDialogue } from "./dots-dialogue";
import { createDotsTasks } from "./dots-tasks";
import { appServices } from "./server-app-services";
export { appServices } from "./server-app-services";
import { createEvents, createSecretBox } from "../domains/dots";
import { createCodingSupervision } from "../domains/coding-supervision";
import { codingObservationReader } from "./coding-observation";
import { createTaskReports } from "../domains/task-reports";
import {
	unavailableCodingWorkflow,
	superviseCodingExecution,
	purgeTaskDependents,
} from "./coding-supervision";
import { createImage, type ImageService } from "../domains/image";
import { createUiCompositions } from "../domains/ui-compositions";
import { createMusic } from "../domains/music";
import { createLarmPlayground } from "../domains/larm";
import { createSavedEmbedder } from "./larm-embedder";
import { createToolchainRouting } from "./toolchain-routing";
import { toolchainMaintenance } from "./toolchain-adapters";
import { createHostToolchain } from "./toolchain-host";
import {
	createAttitudeDataset,
	openAttitudeStore,
} from "../domains/attitude-dataset";
import { dirname, join, resolve } from "node:path";
import { configureLogging, getLogger } from "../infrastructure/logger";
import { createConversationService } from "../domains/conversation";
import { createDialogueService } from "../domains/dialogue";
import { createSettings } from "../domains/settings";
import {
	createInference,
	createCodexResearch,
	createCloudAgents,
} from "../domains/inference";
import { createQueue } from "../domains/queue";
import { createScheduler } from "../domains/scheduler";
import { createTimers } from "../domains/timers";
import { createTimerAnnouncements } from "./timer-announcements";
import { createVoiceDialogue } from "../domains/voice-dialogue";
import { createTtsDictionary } from "../domains/tts-dictionary";
import { createContinuityService } from "../domains/continuity";
import { createMemoryService } from "../domains/memory";
import { recoverSteward } from "./steward-assembly";
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
	createProcessGuard,
	createTerminator,
	intervalLifecycle,
	type Lifecycle,
} from "./lifecycle";
import { createChanges } from "./events";
import { createServiceTests } from "../domains/service-tests";
import { createDelegatedTasks } from "./delegated-tasks";
import { createProductionCoding } from "./coding";
import { createCodingTaskExecution } from "./coding-tasks";
import { assembleCuration } from "./server-world";
import {
	PROCESS_SHUTDOWN_DEADLINE_MS,
	SHUTDOWN_DEADLINE_MS,
	createStartupGate,
} from "../infrastructure/shutdown";

const log = getLogger("server");

/**
 * Constructs every service. Nothing is recovered, started or listening yet, and
 * the process environment is not read: all values come from `config`.
 */
export async function buildServices(
	config: Config,
	dependencies: { googleProvider?: GoogleProvider } = {},
) {
	const { dbPath } = config;
	const store = openStore(dbPath, migrations, { legacyOrder });
	const changes = createChanges();
	const unsubscribeCommits = store.onCommit(() => changes.publish());
	const conversation = createConversationService(store, {
		requireOutbox: true,
	});
	const settings = await createSettings(store, { dbPath, env: config.env });
	const googleAccounts = createGoogleAccounts(store, {
		key: () => settings.derivedKey("google-accounts.credentials"),
		secureCookies: new URL(config.origin).protocol === "https:",
		provider:
			dependencies.googleProvider ??
			googleProviderFromEnv(config.env, config.origin),
	});
	const ttsDictionary = createTtsDictionary(store);
	const datasetPath = resolve(config.attitudeDatasetPath);
	const datasetStore = openAttitudeStore(datasetPath);
	const attitudeDataset = createAttitudeDataset(datasetStore, datasetPath);
	await attitudeDataset.recover();
	const inference = createInference(store, settings, {
		codexResearch: config.webResearchToolsEnabled
			? createCodexResearch(config.env, config.researchCodexExecutable)
			: undefined,
		cloudAgents: createCloudAgents(config.env, {
			codexExecutable: config.researchCodexExecutable,
		}),
		token: config.larmToken,
		providerHosts: config.larmProviderHosts,
		speechText: ttsDictionary.apply,
		attitudeDataset,
	});
	const unsubscribeStatus = inference.onChange(() => changes.publish());
	const serviceTests = createServiceTests(store, settings, inference, {
		token: config.larmToken,
	});
	const queue = createQueue(store, {
		resourceAliases: { "larm.llm": "inference.llm" },
		resources: { "inference.llm": 1, "inference.aux": 2, "web.fetch": 2 },
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
	const dotsSecretBox = createSecretBox(
		config.env.EUMENES_KEY_DIR ?? join(dirname(dbPath), "keys"),
	);
	const dotsEvents = createEvents({ store, queue, ...dotsSecretBox });
	const dots = createDotsTasks({
		store,
		conversation,
		tasks: () => delegated.tasks,
		reports: taskReports,
		capabilities: () => toolchain.capabilities,
		commandPrepared: dotsEvents.enqueueInTransaction,
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
					coding: codingComposition?.coding,
				})
			: undefined;
	const delegated = createDelegatedTasks({
		store,
		queue,
		scheduler,
		enabled: config.delegatedTasksEnabled,
		execution: supervisedExecution,
		additionalKinds: [dots.kind],
		changedInTransaction: (db, t) => {
			if (t.kind === "coding") supervision?.taskChangedInTransaction(db, t);
			else dots.redactInTransaction(db, t);
		},
		purgeInTransaction: (db, t) => {
			purgeTaskDependents(taskReports)(db, t);
			dots.purgeInTransaction(db, t.id);
		},
	});
	const deliverTaskReports = createTaskReportDelivery(
		taskReports,
		delegated.tasks,
		conversation,
	);
	const supervision = workflow
		? createCodingSupervision({
				store,
				tasks: () => delegated.tasks,
				queue,
				inference,
				reports: taskReports,
				workflow,
				observationReader: codingComposition
					? codingObservationReader(store, codingComposition.coding)
					: undefined,
				approveInstructions: () =>
					settings.get().codingSupervision.approveInstructions,
			})
		: undefined;
	// One embedder on the saved LARM connection serves both the toolchain routing and the memory turn vectors.
	const embedder = createSavedEmbedder(config, settings);
	const continuity = createContinuityService(store);
	const memoryJournalPath = resolve(config.memoryJournalPath);
	const memory = createMemoryService(store, conversation, continuity, {
		journalPath: memoryJournalPath,
		embed: () => embedder,
	});
	const { stewardAssembly, steward, goals, world } = assembleCuration(config, {
		store,
		memory,
		conversation,
		continuity,
		queue,
		inference,
		dbPath,
		memoryJournalPath,
		worldResourceId: () => settings.get().world.curationResourceId,
	});
	let imageForCompositions: ImageService;
	const uiCompositions = createUiCompositions({
		store,
		queue,
		inference,
		image: () => imageForCompositions,
	});
	let ocrCapabilities: import("../domains/capabilities").Capabilities | null =
		null;
	const ocr = createOcr({
		store,
		queue,
		connection: () => settings.ocrCredentials(),
		inference,
		capabilities: () => ocrCapabilities,
	});
	const { toolchain, links } = await createHostToolchain({
		dbPath,
		store,
		queue,
		uiCompositions,
		ocr,
		inference,
		webResearch,
		settings,
		conversation,
		googleAccounts,
		ttsDictionary,
		memory,
		steward,
		world,
		goals: goals.goals,
		serviceTests,
		timers,
		log,
		history: config.historyToolsEnabled,
		webResearchEnabled: config.webResearchToolsEnabled,
		embed: embedder,
		terminalHooks: {
			baseUrl: `http://${config.host}:${config.port}`,
			publish: () => changes.publish(),
		},
	});
	ocrCapabilities = toolchain.capabilities;
	const enabled = config.toolchainEnabled;

	const mediaGateway = () => {
		const s = settings.get();
		return createLarmPlayground({
			baseUrl: s.larm.baseUrl ?? undefined,
			token: config.larmToken,
			profile: s.larm.profile,
			audience: s.larm.audience,
			providerHosts: config.larmProviderHosts,
		});
	};
	const mediaDependencies = {
		store,
		queue,
		inference,
		capabilities: toolchain.capabilities,
		gateway: mediaGateway,
		onJob: (db: import("bun:sqlite").Database, runId: string, jobId: string) =>
			dialogue.linkOperationJobInTransaction(db, runId, jobId),
		onFinished: (db: import("bun:sqlite").Database, runId: string) =>
			dialogue.finishOperationInTransaction(db, runId),
	};
	const music = createMusic(mediaDependencies);
	const image = createImage(mediaDependencies);
	imageForCompositions = image;
	const excalidraw = createExcalidraw({
		store,
		webOrigin: config.origin,
		connection: () => {
			const saved = settings.excalidrawCredentials(),
				larmUrl = settings.get().larm.baseUrl;
			if (!saved || !larmUrl)
				throw new Error("excalidraw_connection_unconfigured");
			if (
				saved.consumerToken === config.larmToken ||
				saved.appToken === config.larmToken
			)
				throw new Error("excalidraw_credential_roles_invalid");
			return {
				version: `${larmUrl}:${saved.revision}`,
				gatewayUrl: saved.gatewayUrl,
				gatewayOrigin: saved.gatewayOrigin,
				leaseEndpoint: saved.leaseEndpoint,
				appToken: saved.appToken,
				client: createLocalServices({
					baseUrl: larmUrl,
					token: saved.consumerToken,
				}),
			};
		},
	});
	const drawingOperations = registerDrawingOperations({
		...mediaDependencies,
		service: excalidraw,
	});
	const objectRecognition = createObjectRecognition({
		store,
		queue,
		connection: () => settings.objectRecognitionCredentials(),
	});
	const dialogue = createDialogueService({
		objectRecognition: enabled
			? objectRecognition.port(CONVERSATION_DEFAULT_PRINCIPAL)
			: undefined,
		music: enabled ? music : undefined,
		image: enabled ? image : undefined,
		excalidraw: enabled ? drawingOperations : undefined,
		store,
		conversation,
		larm: inference,
		queue,
		memory,
		steward,
		goals: goals.dialoguePort,
		agents: enabled ? toolchain.agents : undefined,
		postAnswer: enabled ? toolchain.postAnswer : undefined,
		delegation: createDotsDialogue({
			store,
			tasks: delegated.tasks,
			conversation,
			capabilities: toolchain.capabilities,
		}),
		...(world ? { worldContext: world.context } : {}),
		toolchains: enabled
			? createToolchainRouting(
					toolchain.capabilities,
					toolchain.history,
					toolchain.embedQuery,
					toolchain.registry,
					toolchain.schemas,
					toolchain.worldAvailable,
				)
			: undefined,
	});
	links.attachDialogue(dialogue);
	stewardAssembly.attachDialogue(dialogue);
	const voice = createVoiceDialogue(store, dialogue, inference);
	scheduler.registerTarget(dialogue.promptTarget);
	return {
		store,
		changes,
		unsubscribeCommits,
		unsubscribeStatus,
		conversation,
		googleAccounts,
		ttsDictionary,
		datasetStore,
		attitudeDataset,
		inference,
		serviceTests,
		excalidraw,
		drawingOperations,
		image,
		uiCompositions,
		objectRecognition,
		ocr,
		music,
		queue,
		webResearch,
		scheduler,
		timers,
		codingComposition,
		codingExecution,
		taskReports,
		delegated,
		dots,
		dotsEvents,
		deliverTaskReports,
		supervision,
		continuity,
		memory,
		steward,
		settings,
		world,
		toolchain,
		dialogue,
		voice,
	};
}
export type Services = Awaited<ReturnType<typeof buildServices>>;

/**
 * Process lifecycle of the services. The three groups are separate because the
 * three orders differ: recovery order (a journal before the world that reads
 * it, queue before the tasks it carries), start order (runners after every
 * recovery), and bring-up order for resources, which `closeAll` walks in
 * reverse so the shutdown order is exactly: commit/status subscriptions,
 * change stream, HTTP, timers, coding, in-flight maintenance (tasks, store retention,
 * timers), world,
 * supervision, delegated, scheduler, service tests, voice, excalidraw, Claude Code sessions,
 * agents, queue,
 * web research, dialogue, inference, datasets, store.
 */
export function createLifecycles(s: Services, http: Lifecycle): Lifecycle[] {
	// Toolchain and procedure passages are embedded in the background; retrieval falls back
	// to full-text search while a vector is missing.
	const googleMaintenance = intervalLifecycle(
		"google_accounts",
		60_000,
		() => s.googleAccounts.maintain(),
		{ exclusive: true },
	);
	const vectorRefresh = intervalLifecycle(
		"toolchain_vectors",
		600_000,
		() => s.toolchain.refreshVectors(),
		{ exclusive: true },
	);
	const reportDelivery = intervalLifecycle("task_report_delivery", 1000, () =>
		s.store.write(s.deliverTaskReports),
	);
	const taskMaintenance = intervalLifecycle("task_maintenance", 60_000, () =>
		Promise.allSettled([
			s.dots
				.maintenance()
				.catch((error) =>
					log.warn(
						"dots.maintenance_failed",
						{ reason: "maintenance_failed" },
						error,
					),
				),
			s.dotsEvents
				.maintenance()
				.catch((error) =>
					log.warn(
						"dots.events_maintenance_failed",
						{ reason: "maintenance_failed" },
						error,
					),
				),
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
			...toolchainMaintenance(s, log),
		]),
	);
	// Bounded deletes (queue 500, occurrences 500, schedules 100) keep the writer free.
	const storeRetention = intervalLifecycle("store_retention", 3_600_000, () =>
		s.store
			.write((db) => {
				const at = Date.now();
				s.queue.pruneInTransaction(db, at);
				s.scheduler.pruneInTransaction(db, at);
				s.toolchain.terminals.pruneInTransaction(db, new Date(at));
			})
			.catch((error) =>
				log.warn(
					"store.retention_failed",
					{ reason: "retention_failed" },
					error,
				),
			),
	);
	const codingHeartbeat = intervalLifecycle(
		"coding_heartbeat",
		15_000,
		() => s.codingExecution?.heartbeat(),
		{ exclusive: false },
	);
	// Settles board runs whose result could not be applied, and prunes old runs (hourly).
	const kanbanMaintenance = intervalLifecycle(
		"kanban_maintenance",
		30_000,
		() => s.toolchain.kanbanRuns.maintain(),
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
	const drawingMaintenance = intervalLifecycle(
		"excalidraw_idle",
		1000,
		() => s.excalidraw.tick(),
		{ exclusive: true },
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
		{ name: "excalidraw_recovery", recover: () => s.excalidraw.recover() },
		{ name: "voice_recovery", recover: () => s.voice.recover() },
		{ name: "inference_recovery", recover: () => s.inference.recover() },
		{ name: "service_tests_recovery", recover: () => s.serviceTests.recover() },
		{ name: "agents_recovery", recover: () => s.toolchain.agents.recover() },
		{ name: "dialogue_recovery", recover: () => s.dialogue.recover() },
		{
			name: "terminals_recovery",
			recover: () => s.toolchain.terminals.recover(),
		},
		{
			name: "kanban_recovery",
			recover: () => s.toolchain.kanbanRuns.recover(),
		},
		{
			name: "steward_recovery",
			recover: () => s.store.write((db) => recoverSteward(s.steward, db)),
		},
		{ name: "web_research_recovery", recover: () => s.webResearch.recover() },
		{ name: "queue_recovery", recover: () => s.queue.recover() },
		{ name: "delegated_recovery", recover: () => s.delegated.recover() },
		{ name: "dots_recovery", recover: () => s.dots.recover() },
		{
			name: "task_report_recovery",
			recover: () => s.store.write(s.deliverTaskReports),
		},
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
		// Start order. Change-feed/forget consumers: commit notification plus a modest poll; they never create inference jobs.
		{
			name: "toolchain_vectors_start",
			start: () => {
				vectorRefresh.start?.();
				void s.toolchain.refreshVectors();
			},
		},
		{ name: "agents_start", start: () => s.toolchain.agents.start() },
		{ name: "queue_start", start: () => s.queue.start() },
		{
			name: "task_report_delivery_start",
			start: () => reportDelivery.start?.(),
		},
		{ name: "world_start", start: () => s.world?.start() },
		{ name: "web_research_start", start: () => s.webResearch.start() },
		{ name: "excalidraw_start", start: () => drawingMaintenance.start?.() },
		{ name: "scheduler_start", start: () => s.scheduler.start() },
		{ name: "task_maintenance_start", start: () => taskMaintenance.start?.() },
		{ name: "store_retention_start", start: () => storeRetention.start?.() },
		{ name: "coding_heartbeat_start", start: () => codingHeartbeat.start?.() },
		{
			name: "timer_maintenance_start",
			start: () => timerMaintenance.start?.(),
		},
		{
			name: "kanban_maintenance_start",
			start: () => kanbanMaintenance.start?.(),
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
		{ name: "kanban", close: () => s.toolchain.kanbanRuns.disconnect() },
		{ name: "terminals", close: () => s.toolchain.terminals.closeAll() },
		{
			name: "excalidraw",
			close: async () => {
				drawingMaintenance.stop();
				await drawingMaintenance.idle();
				await s.excalidraw.close();
			},
		},
		{ name: "voice", close: () => s.voice.close() },
		{ name: "service_tests", close: () => s.serviceTests.close() },
		{ name: "scheduler", close: () => s.scheduler.close() },
		{ name: "delegated", close: () => s.delegated.close() },
		{ name: "supervision", close: () => s.supervision?.close() },
		// World consumers stop before anything closes the store.
		{ name: "world", close: () => s.world?.close() },
		{ name: "task_maintenance", close: () => taskMaintenance.idle() },
		{ name: "task_report_delivery", close: () => reportDelivery.idle() },
		{ name: "store_retention", close: () => storeRetention.idle() },
		googleMaintenance,
		{ name: "timer_maintenance", close: () => timerMaintenance.idle() },
		{ name: "kanban_maintenance", close: () => kanbanMaintenance.idle() },
		// Worker lease also expires independently if shutdown cannot deliver a stop.
		{ name: "coding", close: () => s.codingComposition?.coding.close() },
		{ name: "coding_execution", close: () => s.codingExecution?.shutdown() },
		{
			name: "timers",
			close: () => {
				reportDelivery.stop();
				taskMaintenance.stop();
				storeRetention.stop();
				codingHeartbeat.stop();
				timerMaintenance.stop();
				kanbanMaintenance.stop();
				vectorRefresh.stop();
			},
		},
		http,
		{ name: "changes", close: () => s.changes.close() },
		{ name: "status", close: () => s.unsubscribeStatus() },
		{ name: "commits", close: () => s.unsubscribeCommits() },
	];
}

// Resources that `buildServices` created before it threw are not registered
// with the runner, so they cannot be closed here; the process exit releases the
// flock and the files.
async function main() {
	const config = loadProcessConfig();
	configureLogging({ file: config.logFile, level: config.logLevel });
	// Resolved lazily: the guard is armed before the terminator exists.
	let terminate: () => void = () => process.exit(1);
	const guard = createProcessGuard({ log, terminate: () => terminate() });
	process.on("unhandledRejection", guard.onRejection);
	process.on("uncaughtException", guard.onException);
	let runner: ReturnType<typeof createLifecycleRunner> | undefined;
	let server: ReturnType<typeof Bun.serve> | undefined;
	// Resolves to true when every step succeeded. A failing step never skips the later ones.
	let stopping: Promise<boolean> | null = null;
	const gate = createStartupGate();
	const shutdown = () =>
		(stopping ??= (async () => {
			log.info("server.shutdown_started");
			// Let the startup step in flight finish before anything closes.
			await gate.settled();
			const ok = runner ? await runner.closeAll(SHUTDOWN_DEADLINE_MS) : true;
			log.info("server.shutdown_completed", { reason: ok ? "ok" : "failed" });
			return ok;
		})());
	// The process-level deadline backs up the runner's own, which normally fires first.
	terminate = createTerminator({
		shutdown,
		exit: (code) => process.exit(code),
		log,
		deadlineMs: PROCESS_SHUTDOWN_DEADLINE_MS,
	});
	for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
		process.on(signal, () => terminate());
	log.info("server.starting");
	try {
		if (config.host !== "127.0.0.1" && config.host !== "localhost")
			throw new Error("loopback_host_required");
		const token = resolveApiToken({
			EUMENES_API_TOKEN: config.apiToken,
			EUMENES_DB: config.dbPath,
			EUMENES_KEY_DIR: config.env.EUMENES_KEY_DIR,
		});
		const services = await gate.step(async () => {
			const built = await buildServices(config);
			runner = createLifecycleRunner(
				createLifecycles(built, {
					name: "http",
					close: () => server?.stop(true),
				}),
			);
			return built;
		});
		if (stopping) return;
		const active = runner as ReturnType<typeof createLifecycleRunner>;
		log.info("server.recovery_started");
		await gate.step(() => active.recoverAll());
		if (stopping) return;
		log.info("server.recovery_completed");
		await gate.step(() => active.startAll());
		if (stopping) return;
		const app = createApp({
			token,
			origin: config.origin,
			modules: appModules(appServices(services)),
		});
		await gate.step(() => {
			try {
				server = Bun.serve({
					hostname: config.host,
					port: config.port,
					idleTimeout: 60,
					fetch: app.fetch,
				});
			} catch (error) {
				if ((error as { code?: unknown } | null)?.code === "EADDRINUSE")
					throw new Error("port_in_use");
				throw error;
			}
		});
		if (stopping || !server) return;
		log.info("server.listening", { port: (server as { port: number }).port });
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
	} catch (error) {
		// A failure caused by an in-progress shutdown is left to the terminator.
		if (stopping) return;
		await shutdown();
		throw error;
	}
}

/**
 * Startup failure messages that are stable codes and carry no secret. Anything
 * else (OS errors, paths, provider text) collapses to `startup_failed`.
 */
const SAFE_STARTUP_CODES = [
	/^config_invalid:[A-Z0-9_]+$/,
	/^migration_[a-z_]+:[A-Za-z0-9/._-]{1,120}$/,
	/^migration_[a-z_]+$/,
	/^(database_writer_owned|world_cursor_secret_invalid|api_token_file_invalid|loopback_host_required|port_in_use)$/,
	/^secret_key_[a-z_]+$/,
];

/** The stable, non-sensitive reason code of a startup failure. */
export function startupFailureReason(error: unknown): string {
	const message = error instanceof Error ? error.message : undefined;
	if (message === "EUMENES_API_TOKEN must be at least 24 characters")
		return "api_token_too_short";
	if (
		message &&
		!message.includes("..") &&
		SAFE_STARTUP_CODES.some((p) => p.test(message))
	)
		return message;
	return "startup_failed";
}

// Importing this module only defines functions; the process starts when it is the entry point.
if (import.meta.main) {
	await main().catch((error) => {
		const reason = startupFailureReason(error);
		log.error("server.startup_failed", { reason }, error);
		process.stderr.write(`[eumenes] startup failed: ${reason}\n`);
		process.exit(1);
	});
}
