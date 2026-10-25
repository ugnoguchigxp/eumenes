import { buildVisualPerception } from "./media/visual-perception";
import { createLateResources } from "./resources/late";
import { buildResources } from "./resources/wiring";
import { buildDocling } from "./docling/docling-composition";
import { createDotsMessages } from "./work/dots-messages";
import { createDotsWork } from "./work/dots-work";
import { dirname, resolve } from "node:path";
import type { GoogleProvider } from "../domains/google-accounts";
import { CONVERSATION_DEFAULT_PRINCIPAL } from "../domains/conversation/contracts";
import { createContinuityService } from "../domains/continuity";
import { createDialogueService } from "../domains/dialogue";
import { configureTaskExecution } from "./toolchain/task-execution-port";
import { taskMediaPorts } from "./toolchain/task-media-execution";
import { taskLegacyPorts } from "./toolchain/task-legacy-execution";
import {
	REFERENCE_WINDOW_TOKENS,
	planWindow,
	createConnectionModels,
} from "../domains/inference";
import { NOMINAL_FIXED_TOKENS, createMemoryService } from "../domains/memory";
import { createOcr } from "../domains/ocr";
import { createScheduler } from "../domains/scheduler";
import { createTimers } from "../domains/timers";
import { createUiCompositions } from "../domains/ui-compositions";
import { createVoiceDialogue } from "../domains/voice-dialogue";
import type { Capabilities } from "../domains/capabilities";
import { getLogger } from "../infrastructure/logger";
import type { Config } from "../infrastructure/config";
import { createDotsDialogue } from "./work/dots-dialogue";
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
import { createPipelinesService } from "./pipelines/pipelines-service";
import { createPipelineTrials } from "./pipelines/pipelines-trials";
import { createHostToolchain } from "./toolchain/toolchain-host";
import { assembleAgency } from "./agency/assembly";
import { createConversationPrewarm } from "./conversation-prewarm";
import { createAgencyWork } from "./agency/work";

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
	const continuity = createContinuityService(store);
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
	const docling = buildDocling(settings);
	const uiCompositions = createUiCompositions();
	let ocrCapabilities: Capabilities | null = null;
	const ocr = createOcr({
		visual: buildVisualPerception(config, settings),
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
	const { toolchain, links } = await createHostToolchain({
		resources: lateResources,
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
		uiCompositions,
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
		capabilities: toolchain.capabilities,
		gateway: media.gateway,
		events: continuity.events,
		webResearch,
		shell: toolchain.shell,
	});
	const toolchains = enabled
		? createToolchainRouting(
				toolchain.capabilities,
				toolchain.history,
				toolchain.embedQuery,
				toolchain.registry,
				toolchain.schemas,
				toolchain.worldAvailable,
			)
		: undefined;
	// The conversation agent: its replies, and its spontaneous speech (runtimes per conversation, fed by the
	// conversation outbox). The dialogue service is built below (it takes this host's ports).
	const agency = assembleAgency(
		{ store, conversation, inference, settings, memory },
		() => dialogue,
	);
	const dialogue = createDialogueService({
		resources: {
			registry: resources.access.registry,
			producesInTransaction: (db, toolchainId) =>
				toolchain.capabilities.producesInTransaction(db, toolchainId),
		},
		agency: agency.dialoguePort,
		conversationAgent: agency.conversationAgent,
		logFile: () => config.logFile,
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
		goals: goals.dialoguePort,
		agents: enabled ? toolchain.agents : undefined,
		delegation: createDotsDialogue({ tasks: delegated.tasks }),
		...(world ? { worldContext: world.context } : {}),
		...(toolchains
			? {
					toolchains,
					specialist: createSpecialistPort({
						routing: toolchains,
						registry: toolchain.registry,
						schemas: toolchain.schemas,
						clock: () => new Date().toISOString(),
					}),
				}
			: {}),
	});
	// A forgotten State item must not stay a topic suggestion.
	memory.registerForgetPurge(() => agency.invalidateTopics());
	links.attachDialogue(dialogue);
	if (enabled && toolchains)
		configureTaskExecution({
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
	// The agency sees the conversation's open TODOs; the conversation reports their results itself.
	agency.attachWork(
		createAgencyWork({ dialogue, resources: resources.access.registry }),
	);
	lateResources.attach(resources.access.registry);
	stewardAssembly.attachDialogue(dialogue);
	// The latest conversation's prompt is read ahead when it would be cold (started, shown, idle while shown).
	const prewarm = createConversationPrewarm({
		store,
		inference,
		latestConversationIdInTransaction:
			dialogue.latestConversationIdInTransaction,
		prefix: dialogue.conversationPrefixInTransaction,
	});
	memory.registerForgetPurge(
		toolchain.agents.executions.purgeSourcesInTransaction,
	);
	const voice = createVoiceDialogue(store, dialogue, inference);
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
	const pipelines = toolchains
		? createPipelinesService({
				store,
				capabilities: toolchain.capabilities,
				registry: toolchain.registry,
				routing: toolchains,
				schemas: toolchain.schemas,
				refreshVectors: toolchain.refreshVectors,
			})
		: undefined;
	if (pipelines) toolchain.attachPipelines(pipelines);
	const pipelineTrials =
		pipelines && toolchains
			? createPipelineTrials({
					store,
					capabilities: toolchain.capabilities,
					routing: toolchains,
					inference,
					service: pipelines,
					agentSystem: agency.conversationAgent.system,
					embedPassages: toolchain.embedPassages,
				})
			: undefined;
	return {
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
		connectionModels: createConnectionModels(settings, config.env, { store }),
		serviceTests,
		docling,
		excalidraw: media.excalidraw,
		drawingOperations: media.drawingOperations,
		image: media.image,
		uiCompositions,
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
		steward,
		settings,
		world,
		toolchain,
		pipelines,
		pipelineTrials,
		resources,
		dialogue,
		agency,
		prewarm,
		voice,
		monitoring,
	};
}
export type Services = Awaited<ReturnType<typeof buildServices>>;
