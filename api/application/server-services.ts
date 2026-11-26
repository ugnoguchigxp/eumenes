import { dirname, resolve } from "node:path";
import { createSteeringInbox } from "eumenes-steer";
import type { Capabilities } from "../domains/capabilities";
import { createContinuityService } from "../domains/continuity";
import type { GoogleProvider } from "../domains/google-accounts";
import { REFERENCE_WINDOW_TOKENS, planWindow } from "../domains/inference";
import { NOMINAL_FIXED_TOKENS, createMemoryService } from "../domains/memory";
import { createScheduler } from "../domains/scheduler";
import { createTimers } from "../domains/timers";
import type { ToolchainExecutionPort } from "../domains/tool-runtime";
import type { Config } from "../infrastructure/config";
import { getLogger } from "../infrastructure/logger";
import { assembleAgency } from "./agency/assembly";
import {
	agendaGoalDeps,
	createAgendaGoalStore,
	goalForgetDeps,
} from "./agency/goal-agenda";
import { createNoteDocuments } from "./agency/note-documents";
import { createRegisteredGoals } from "./agency/registered-goals";
import { createGoalWorkspaceRegistry } from "./agency/goal-workspaces";
import { createLiveBridge } from "./media/live-bridge";
import { createMemoryHostConnection } from "./memory-host";
import { createLateResources } from "./resources/late";
import { buildResources } from "./resources/wiring";
import { buildCore, buildWebResearch } from "./server-core";
import { buildMedia } from "./server-media";
import { buildTasks } from "./server-tasks";
import {
	buildDialogueService,
	buildHostToolchainService,
	buildKnowledgeService,
	buildMonitoringService,
	buildWorkspaceServices,
	registerForgetPurges,
	wireToolchainExecution,
} from "./server-wiring";
import { assembleCuration } from "./server-world";
import { createTimerAnnouncements } from "./timers/timer-announcements";
import { createToolchainRouting } from "./toolchain/toolchain-routing";
import { createSearchCheck } from "./toolchain/toolchain-search-check";
import { createDotsMessages } from "./work/dots-messages";

const log = getLogger("server");

function buildRegisteredGoalServices(
	core: Awaited<ReturnType<typeof buildCore>>,
	ports: {
		goals: Parameters<typeof goalForgetDeps>[0];
		agendaGoalStore: ReturnType<typeof createAgendaGoalStore>;
		toolchain: Awaited<
			ReturnType<typeof buildHostToolchainService>
		>["toolchain"];
		goalWorkspaces: ReturnType<typeof createGoalWorkspaceRegistry>;
		memory: ReturnType<typeof createMemoryService>;
		continuity: NonNullable<
			Parameters<typeof createRegisteredGoals>[0]["records"]
		>["continuity"];
		markdown: Parameters<typeof createRegisteredGoals>[0]["markdown"];
	},
) {
	const { store, conversation, settings, inference, queue } = core;
	const {
		goals,
		agendaGoalStore,
		toolchain,
		goalWorkspaces,
		memory,
		continuity,
		markdown,
	} = ports;
	return createRegisteredGoals({
		store,
		goals: agendaGoalStore,
		conversation,
		settings,
		inference,
		queue,
		capabilities: toolchain.capabilities,
		webNote: toolchain.webNote,
		claude: toolchain.claudeCode,
		onWorkerAvailabilityChange: toolchain.claudeCode.onAvailabilityChange,
		workspaces: goalWorkspaces,
		referenceInputs: memory.referenceInputs,
		records: {
			conversation,
			memory,
			continuity,
			agendaGoals: { store: agendaGoalStore, ...goalForgetDeps(goals) },
		},
		markdown,
		activity: inference,
		...(toolchain.developmentSupervision
			? { supervision: toolchain.developmentSupervision }
			: {}),
		blocked: (db, id) => memory.isBlockedInTransaction(db, id),
	});
}

function buildServerAgency(
	core: Awaited<ReturnType<typeof buildCore>>,
	ports: Omit<
		Parameters<typeof buildRegisteredGoalServices>[1],
		"agendaGoalStore"
	> & {
		dbPath: string;
		toolchains: ReturnType<typeof createToolchainRouting> | undefined;
		steward: ReturnType<typeof assembleCuration>["steward"];
		resources: ReturnType<typeof buildResources>;
		liveBridge: ReturnType<typeof createLiveBridge>;
		noteDocuments: ReturnType<typeof createNoteDocuments>;
		dialogue: Parameters<typeof assembleAgency>[1];
		execution: () => ToolchainExecutionPort | undefined;
	},
) {
	const { store, settings, changes } = core;
	const {
		dbPath,
		goals,
		toolchain,
		toolchains,
		goalWorkspaces,
		memory,
		continuity,
		markdown,
		steward,
		resources,
		liveBridge,
		noteDocuments,
	} = ports;
	// One steering inbox per server (eumenes-steer): words the user sends while a reply is written reach that
	// reply's next model call. The agency opens one target per reply.
	const steering = createSteeringInbox({ now: Date.now });
	const memoryHost = createMemoryHostConnection(
		memory,
		dirname(resolve(dbPath)),
	);
	const agendaGoalStore = createAgendaGoalStore(store, goals);
	const registeredGoals = buildRegisteredGoalServices(core, {
		goals: goals,
		agendaGoalStore,
		toolchain,
		goalWorkspaces,
		memory,
		continuity,
		markdown,
	});
	const agency = assembleAgency(
		{
			...core,
			memory,
			continuity,
			steward,
			noteDocuments,
			goalResearchNoteInTransaction: registeredGoals.adoptNote,
			agendaGoals: agendaGoalDeps({
				store: agendaGoalStore,
				goals: goals,
				mockDir: resolve(dirname(dbPath), "agenda-goal-mock"),
				memoryHost,
				reply: registeredGoals.reply,
				quiet: registeredGoals.quiet,
				readDesign: registeredGoals.readDesign,
			}),
			research: {
				agents: toolchain.agents,
				toolchains,
				settings,
				resources: resources.access.registry,
				producesInTransaction: resources.dialogue.producesInTransaction,
				execution: ports.execution,
				// A stopped assignment's queued jobs are aborted at once (a LARM request is cancelled there).
				queue: core.queue,
			},
			...liveBridge.agency,
			steering,
			publish: () => changes.publish(),
		},
		ports.dialogue,
	);
	return { agency, agendaGoalStore, registeredGoals, memoryHost };
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
	const knowledge = buildKnowledgeService(core, config);
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
	// One embedder on the saved LARM connection serves both the toolchain routing and the memory turn vectors.
	const embedder: typeof inference.embed = (...args) =>
		core.activity.embedding.track(() => inference.embed(...args), args[2]);
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
		settings,
	});
	let toolchainCapabilities: Capabilities | null = null;
	const workspace = buildWorkspaceServices(config, {
		core,
		scheduler,
		webResearch,
		getCapabilities: () => toolchainCapabilities,
		getToolchain: () => toolchain,
	});
	const {
		docling,
		markdown,
		uiCompositions,
		workflow,
		ocr,
		model3d,
		video,
		compute,
		browser,
		canvas,
	} = workspace;
	// The toolchain's `resources` tool and `resource.read` reach the registry and ledger once they exist.
	const lateResources = createLateResources(store);
	const goalWorkspaces = createGoalWorkspaceRegistry(config.goalWorkspaces);
	const { toolchain, links, webNote } = await buildHostToolchainService(
		config,
		{
			core,
			goalWorkspaces,
			workspace,
			lateResources,
			tasks,
			dotsMessages,
			webResearch,
			memory,
			steward,
			world,
			goals,
			scheduler,
			timers,
			embedder,
			log,
		},
	);
	const workflowPorts = workflow.attach({
		capabilities: toolchain.capabilities,
		agents: toolchain.agents.executions,
	});
	toolchainCapabilities = toolchain.capabilities;
	const enabled = config.toolchainEnabled;
	const media = buildMedia(config, {
		core,
		agents: toolchain.agents,
		capabilities: toolchain.capabilities,
	});
	const resources = buildResources({
		store,
		markdown,
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
			)
		: undefined;
	const liveBridge = createLiveBridge();
	let agencyExecution: ToolchainExecutionPort | undefined;
	// The agency's research notes are documents of the Markdown domain, as a research report is.
	const noteDocuments = createNoteDocuments({
		store,
		markdown,
		scratch: core.scratch,
		ledger: () => dialogue.resourceLedger,
	});
	const { agency, agendaGoalStore, registeredGoals, memoryHost } =
		buildServerAgency(core, {
			dbPath,
			goals: goals.goals,
			toolchain,
			toolchains,
			goalWorkspaces,
			memory,
			continuity,
			markdown,
			steward,
			resources,
			liveBridge,
			noteDocuments,
			dialogue: () => dialogue,
			execution: () => agencyExecution,
		});
	const dialogue = buildDialogueService(config, {
		store,
		settings,
		changes,
		conversation,
		inference,
		queue,
		scheduler,
		workflow,
		liveBridge,
		resources,
		agency,
		webNote,
		media,
		continuity,
		memory,
		steward,
		world,
		toolchain,
		toolchains,
		knowledge,
	});
	workflow.attachDialogue(dialogue);
	links.attachDialogue(dialogue);
	knowledge.attachDialogue(dialogue);
	if (enabled && toolchains) {
		agencyExecution = wireToolchainExecution({
			goalWorkspaces,
			...(registeredGoals.authority
				? { goalAuthority: registeredGoals.authority }
				: {}),
			toolchain,
			toolchains,
			workflowPorts,
			settings,
			browser,
			queue,
			store,
			dialogue,
			conversation,
			memory,
			inference,
			media,
			resources,
			markdown,
			knowledge,
			goals,
			world,
		});
	}
	lateResources.attach(resources.access.registry);
	stewardAssembly.attachDialogue(dialogue);
	registerForgetPurges({
		memory,
		agency,
		agendaGoalStore,
		registeredGoals,
		noteDocuments,
		toolchain,
		knowledge,
		webResearch,
		dialogue,
	});
	const { voice, liveVoice, prewarm } = liveBridge.attach({
		...core,
		conversation,
		dialogue,
		memory,
		agency: agency.dialoguePort,
	});
	const monitoring = buildMonitoringService(config, {
		store,
		settings,
		inference,
		queue,
		activity: core.activity,
		media,
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
		video,
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
		memoryHost,
		steward,
		settings,
		world,
		toolchain,
		searchCheck,
		resources,
		dialogue,
		agency,
		prewarm,
		registeredGoals,
		goalLedger: goals.goals,
		voice,
		monitoring,
	};
}
export type Services = Awaited<ReturnType<typeof buildServices>>;
