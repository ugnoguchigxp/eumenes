import { createSteeringInbox } from "eumenes-steer";
import {
	configuredContextStill,
	createKnowledge,
	permitsSpecialistContextSearch,
} from "./knowledge/service";
import { createAppDevelopmentRuntime } from "./app-development/runtime";
import { createGitObservation } from "../domains/git-observation";
import { createMemoryHostConnection } from "./memory-host";
import type { ToolchainExecutionPort } from "../domains/tool-runtime";
import { buildAnalysisFactory } from "./media/visual-perception";
import { createLiveBridge } from "./media/live-bridge";
import { createLateResources } from "./resources/late";
import { buildResources } from "./resources/wiring";
import { buildMarkdown } from "./markdown/markdown-composition";
import { createCanvasRuntime, canvasPreviewOrigin } from "./canvas/runtime";
import { createCanvasJobs } from "./canvas/jobs";
import { createCanvasAdapter } from "./canvas/adapter";
import { buildDocling } from "./docling/docling-composition";
import { createDotsMessages } from "./work/dots-messages";
import { createDotsWork } from "./work/dots-work";
import { dirname, join, resolve } from "node:path";
import type { GoogleProvider } from "../domains/google-accounts";
import { CONVERSATION_DEFAULT_PRINCIPAL } from "../domains/conversation/contracts";
import { createContinuityService } from "../domains/continuity";
import { createDialogueService } from "../domains/dialogue";
import { configureTaskExecution } from "./toolchain/task-execution-port";
import { toolchainForgetPurge } from "./toolchain/toolchain-forget";
import { createSearchCheck } from "./toolchain/toolchain-search-check";
import { taskMediaPorts } from "./toolchain/task-media-execution";
import { taskLegacyPorts } from "./toolchain/task-legacy-execution";
import { REFERENCE_WINDOW_TOKENS, planWindow } from "../domains/inference";
import { NOMINAL_FIXED_TOKENS, createMemoryService } from "../domains/memory";
import { createOcr } from "../domains/ocr";
import { createScheduler } from "../domains/scheduler";
import { createTimers } from "../domains/timers";
import { createUiCompositions } from "../domains/ui-compositions";
import type { Capabilities } from "../domains/capabilities";
import { getLogger } from "../infrastructure/logger";
import type { Config } from "../infrastructure/config";
import { createSavedEmbedder } from "./world/larm-embedder";
import {
	createMonitoring,
	createLarmCollector,
	createLarmRepository,
} from "../domains/monitoring";
import { buildCore, buildWebResearch } from "./server-core";
import { buildCompute } from "./compute/compute-composition";
import { buildMedia, buildModel3d } from "./server-media";
import { buildTasks } from "./server-tasks";
import { assembleCuration } from "./server-world";
import { createTimerAnnouncements } from "./timers/timer-announcements";
import { createSpecialistPort } from "./toolchain/specialist-port";
import { buildBrowser } from "./browser/browser-composition";
import { createToolchainRouting } from "./toolchain/toolchain-routing";
import { createHostToolchain } from "./toolchain/toolchain-host";
import { createCodexWebNote } from "./web-note/codex-web-note";
import { assembleAgency } from "./agency/assembly";
import { createNoteDocuments } from "./agency/note-documents";
import { createAgencyWork } from "./agency/work";

const log = getLogger("server");

function buildKnowledge(
	core: Awaited<ReturnType<typeof buildCore>>,
	config: Config,
) {
	const { store, queue, inference } = core;
	return createKnowledge({
		store,
		queue,
		control: inference,
		selectionResourceId: config.knowledgeSelectionResourceId,
		source: configuredContextStill(config.contextStill ?? {}),
		specialistContextSearch: permitsSpecialistContextSearch(
			config.contextStill?.url,
		),
	});
}

/**
 * Constructs every service. Nothing is recovered, started or listening yet, and
 * the process environment is not read: all values come from `config`.
 */
export async function buildServices(
	config: Config,
	dependencies: { googleProvider?: GoogleProvider } = {},
) {
	const { dbPath } = config;
	const core = await buildCore(config, dependencies);
	const {
		store,
		changes,
		conversation,
		settings,
		googleAccounts,
		ttsDictionary,
		inference,
		serviceTests,
		queue,
	} = core;
	const knowledge = buildKnowledge(core, config);
	const webResearch = buildWebResearch(config, core);
	const scheduler = createScheduler(store, queue);
	const timers = createTimers(
		store,
		{ scheduler, queue },
		{
			publish: () => changes.publish(),
			onElapsedInTransaction: createTimerAnnouncements(conversation),
		},
	);
	const tasks = await buildTasks(config, {
		core,
		scheduler,
		capabilities: () => toolchain.capabilities,
	});
	const { delegated } = tasks;
	// One embedder on the saved LARM connection serves both the toolchain routing and the memory turn vectors.
	const embedder = createSavedEmbedder(
		config,
		settings,
		core.activity.embedding,
	);
	const continuity = createContinuityService();
	const dotsMessages = createDotsMessages({
		store,
		conversation,
		continuity,
		commands: tasks.dots.commands,
		events: tasks.dotsEvents,
	});
	const memoryJournalPath = resolve(config.memoryJournalPath);
	const memory = createMemoryService(store, conversation, continuity, {
		journalPath: memoryJournalPath,
		embed: () => embedder,
		// The saved model's window plan (the reference window while it is not known): background work sizes from it.
		windowPlan: () =>
			planWindow({
				window: inference.savedLlmContextWindow?.() ?? REFERENCE_WINDOW_TOKENS,
				fixed: NOMINAL_FIXED_TOKENS,
			}),
	});
	// Forgetting revokes agent calls still running on what was forgotten (a no-op when replayed at startup).
	memory.registerForgetPurge(inference.revokeAgentAttemptsInTransaction);
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
	const docling = buildDocling(settings, config.larmToken);
	const markdown = buildMarkdown(store, queue, docling, () =>
		changes.publish(),
	);
	const uiCompositions = createUiCompositions();
	const workflow = createAppDevelopmentRuntime({
		store,
		queue,
		scheduler,
		markdown,
		scratch: core.scratch,
		web: webResearch,
		inference,
		git: createGitObservation(resolve(dirname(dbPath), "workflow-git")),
		storageRoot: resolve(dirname(dbPath), "app-storage"),
		storageChanged: () => changes.publish(),
		destination: () =>
			docling.documents.available()
				? {
						namespace: "eumenes",
						path: "開発日誌",
						binding: docling.documents.binding(),
					}
				: null,
	});
	let ocrCapabilities: Capabilities | null = null;
	const ocr = createOcr({
		analyses: buildAnalysisFactory(config, settings, store, queue),
		store,
		queue,
		connection: () => settings.ocrCredentials(),
		inference,
		capabilities: () => ocrCapabilities,
	});
	const model3d = buildModel3d(config, { core, conversation });
	const compute = buildCompute(config, {
		core,
		conversation,
		validChild: (db, child) =>
			toolchain.agents.executions.authorizeChildInTransaction(db, child),
	});
	let browserCapabilities: Capabilities | null = null;
	const browser = buildBrowser(config, {
		core,
		settings,
		conversation,
		inference,
		capabilities: () => browserCapabilities,
	});
	// The toolchain's `resources` tool and `resource.read` reach the registry and ledger once they exist.
	const lateResources = createLateResources(store);
	const previewOrigin = config.toolchainEnabled
		? canvasPreviewOrigin(config.origin, config.env.EUMENES_CANVAS_PREVIEW_PORT)
		: null;
	const canvasRuntime = previewOrigin
		? createCanvasRuntime({
				hostOrigin: config.origin,
				previewOrigin,
				dataDir: join(dirname(dbPath), "canvas"),
				store,
				inference,
			})
		: null;
	const canvas = canvasRuntime
		? {
				runtime: canvasRuntime,
				jobs: createCanvasJobs(queue, canvasRuntime, store, conversation),
			}
		: undefined;
	const { toolchain, links } = await createHostToolchain({
		resources: lateResources,
		canvasAdapter:
			canvas && createCanvasAdapter(canvas.runtime, canvas.jobs, conversation),
		scratch: core.scratch,
		docling,
		dotsWork: createDotsWork({
			tasks: delegated.tasks,
			reports: tasks.taskReports,
			conversation,
			capabilities: () => toolchain.capabilities,
		}),
		dotsConfiguration: tasks.dots.config,
		dotsMessages,
		dbPath,
		store,
		queue,
		appDevelopmentAdapter: workflow.adapter,
		markdown,
		ocr,
		model3d,
		compute,
		browser,
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
		schedules: {
			scheduler,
			workflowTitle: (db, id) => workflow.apps.app(db, id)?.title,
		},
		log,
		history: config.historyToolsEnabled,
		webResearchEnabled: config.webResearchToolsEnabled,
		webNote: createCodexWebNote(
			config.env,
			config.researchCodexExecutable,
			inference,
		),
		embed: embedder,
		terminalHooks: {
			baseUrl: `http://${config.host}:${config.port}`,
			publish: () => changes.publish(),
		},
	});
	const workflowPorts = workflow.attach({
		capabilities: toolchain.capabilities,
		agents: toolchain.agents.executions,
	});
	ocrCapabilities = toolchain.capabilities;
	browserCapabilities = toolchain.capabilities;
	const enabled = config.toolchainEnabled;
	const media = buildMedia(config, {
		core,
		agents: toolchain.agents,
		capabilities: toolchain.capabilities,
		dialogue: () => dialogue,
	});
	const resources = buildResources({
		store,
		retireUiCompositions: true,
		capabilities: toolchain.capabilities,
		gateway: media.gateway,
		events: continuity.events,
		webResearch,
		shell: toolchain.shell,
		scratch: core.scratch,
	});
	const toolchains = enabled
		? createToolchainRouting(
				toolchain.capabilities,
				toolchain.history,
				toolchain.embedQuery,
				toolchain.registry,
				toolchain.schemas,
				toolchain.worldAvailable,
				toolchain.embedRouter,
			)
		: undefined;
	const liveBridge = createLiveBridge();
	// One steering inbox per server (eumenes-steer): words the user sends while a reply is written reach that
	// reply's next model call. The agency opens one target per reply; dialogue and pursuit may share it later.
	const steering = createSteeringInbox({ now: Date.now });
	let agencyExecution: ToolchainExecutionPort | undefined;
	// The agency's research notes are documents of the Markdown domain, as a research report is.
	const noteDocuments = createNoteDocuments({
		store,
		markdown,
		scratch: core.scratch,
		ledger: () => dialogue.resourceLedger,
	});
	const agency = assembleAgency(
		{
			...core,
			memory,
			noteDocuments,
			research: {
				agents: toolchain.agents,
				toolchains,
				store,
				settings,
				resources: resources.access.registry,
				producesInTransaction: resources.dialogue.producesInTransaction,
				execution: () => agencyExecution,
			},
			...liveBridge.agency,
			steering,
			publish: () => changes.publish(),
		},
		() => dialogue,
	);
	const dialogue = createDialogueService({
		externalOutput: liveBridge.externalOutput,
		resources: resources.dialogue,
		agency: agency.dialoguePort,
		conversationAgent: agency.conversationAgent,
		logFile: () => config.logFile,
		// The context keeper is off for now (2026-10-29 user instruction, the review fixes design C5): no State of its
		// own reaches the input, and the recent conversation is cut by the host's fixed rules alone.
		objectRecognition: enabled
			? media.objectRecognition.port(CONVERSATION_DEFAULT_PRINCIPAL)
			: undefined,
		music: enabled ? media.music : undefined,
		image: enabled ? media.image : undefined,
		excalidraw: enabled ? media.drawingOperations : undefined,
		store,
		conversation,
		larm: inference,
		queue,
		continuity,
		memory,
		steward,
		agents: enabled ? toolchain.agents : undefined,
		...(world ? { worldContext: world.context } : {}),
		...(toolchains
			? {
					toolchains,
					specialist: createSpecialistPort({
						routing: toolchains,
						registry: toolchain.registry,
						schemas: toolchain.schemas,
						knowledge,
						clock: () => new Date().toISOString(),
					}),
				}
			: {}),
	});
	memory.registerForgetPurge(
		agency.forgetInTransaction,
		agency.planForgetInTransaction,
	);
	workflow.attachDialogue(dialogue);
	links.attachDialogue(dialogue);
	knowledge.attachDialogue(dialogue);
	if (enabled && toolchains)
		agencyExecution = configureTaskExecution({
			settings,
			...workflowPorts,
			pursuit: toolchain.pursuit,
			webNote: toolchain.webNote,
			collaboration: toolchain.collaboration,
			interact: browser.interact,
			queue,
			childOperations: toolchain.childOperations,
			store,
			capabilities: toolchain.capabilities,
			agents: toolchain.agents,
			routing: toolchains,
			registry: toolchain.registry,
			dialogue,
			conversation,
			memory,
			inference,
			browser: browser.service,
			media: taskMediaPorts({
				image: media.image,
				music: media.music,
				excalidraw: media.drawingOperations,
			}),
			legacy: taskLegacyPorts(dialogue),
			resources: resources.access.registry,
		});
	agency.attachWork(createAgencyWork({ dialogue }));
	lateResources.attach(resources.access.registry);
	stewardAssembly.attachDialogue(dialogue);
	memory.registerForgetPurge(toolchainForgetPurge(toolchain));
	const audioDeps = {
		...core,
		conversation,
		continuity,
		dialogue,
		memory,
		agency: agency.dialoguePort,
	};
	const { voice, liveVoice, prewarm } = liveBridge.attach(audioDeps);
	const monitoring = createMonitoring({
		remote: createLarmCollector({
			config: () => ({
				baseUrl: settings.get().larm.baseUrl,
				token: config.larmToken,
			}),
			onChange: settings.onChange,
			repository: createLarmRepository(store),
		}),
		settings,
		larmStatus: () => inference.status(),
		attempts: inference.attemptActivity,
		image: media.image.activity,
		music: media.music.activity,
		embedding: core.activity.embedding,
		judge: core.activity.judge,
		queue,
		dataDir: dirname(resolve(dbPath)),
	});
	scheduler.registerTarget(dialogue.promptTarget);
	const searchCheck = toolchains
		? createSearchCheck({
				store,
				capabilities: toolchain.capabilities,
				history: toolchain.history,
				routing: toolchains,
			})
		: undefined;
	return {
		knowledge,
		liveVoice,
		store,
		changes,
		unsubscribeCommits: core.unsubscribeCommits,
		unsubscribeStatus: core.unsubscribeStatus,
		conversation,
		googleAccounts,
		ttsDictionary,
		datasetStore: core.datasetStore,
		attitudeDataset: core.attitudeDataset,
		inference,
		connectionModels: core.connectionModels,
		serviceTests,
		docling,
		canvas,
		excalidraw: media.excalidraw,
		drawingOperations: media.drawingOperations,
		image: media.image,
		uiCompositions,
		workflow,
		markdown,
		scratch: core.scratch,
		objectRecognition: media.objectRecognition,
		ocr,
		model3d,
		compute,
		browser,
		music: media.music,
		queue,
		webResearch,
		scheduler,
		timers,
		...tasks,
		dotsMessages,
		continuity,
		memory,
		memoryHost: createMemoryHostConnection(memory, dirname(resolve(dbPath))),
		steward,
		settings,
		world,
		toolchain,
		searchCheck,
		resources,
		dialogue,
		agency,
		prewarm,
		voice,
		monitoring,
	};
}
export type Services = Awaited<ReturnType<typeof buildServices>>;
