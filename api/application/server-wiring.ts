import { dirname, join, resolve } from "node:path";
import type { Capabilities } from "../domains/capabilities";
import { CONVERSATION_DEFAULT_PRINCIPAL } from "../domains/conversation/contracts";
import type { createContinuityService } from "../domains/continuity";
import {
	createDialogueService,
	commandInputMessageIdsInTransaction,
} from "../domains/dialogue";
import { createGitObservation } from "../domains/git-observation";
import type { createMemoryService } from "../domains/memory";
import { forgetPursuitReports } from "../domains/pursuit";
import {
	createLarmCollector,
	createLarmRepository,
	createMonitoring,
} from "../domains/monitoring";
import { createOcr } from "../domains/ocr";
import type { createScheduler } from "../domains/scheduler";
import type { createTimers } from "../domains/timers";
import { createUiCompositions } from "../domains/ui-compositions";
import { createConversationLookup } from "../domains/web-note";
import type { Config } from "../infrastructure/config";
import type { getLogger } from "../infrastructure/logger";
import type { assembleAgency } from "./agency/assembly";
import {
	type createAgendaGoalStore,
	forgetGoalDocuments,
} from "./agency/goal-agenda";
import type { createNoteDocuments } from "./agency/note-documents";
import { createAppDevelopmentRuntime } from "./app-development/runtime";
import { buildBrowser } from "./browser/browser-composition";
import { createCanvasAdapter } from "./canvas/adapter";
import { createCanvasJobs } from "./canvas/jobs";
import { canvasPreviewOrigin, createCanvasRuntime } from "./canvas/runtime";
import { buildCompute } from "./compute/compute-composition";
import { buildDocling } from "./docling/docling-composition";
import {
	configuredContextStill,
	createKnowledge,
	permitsSpecialistContextSearch,
} from "./knowledge/service";
import { buildMarkdown } from "./markdown/markdown-composition";
import { generatedImageInput } from "./media/generated-image-input";
import type { createLiveBridge } from "./media/live-bridge";
import { buildAnalysisFactory } from "./media/visual-perception";
import type { createLateResources } from "./resources/late";
import type { buildResources } from "./resources/wiring";
import { createSchedulerDiagnostics } from "./scheduler/scheduler-diagnostics";
import type { buildCore, buildWebResearch } from "./server-core";
import { type buildMedia, buildModel3d, buildVideo } from "./server-media";
import type { buildTasks } from "./server-tasks";
import type { assembleCuration } from "./server-world";
import { createSpecialistPort } from "./toolchain/specialist-port";
import { configureTaskExecution } from "./toolchain/task-execution-port";
import { taskLegacyPorts } from "./toolchain/task-legacy-execution";
import { taskMediaPorts } from "./toolchain/task-media-execution";
import { toolchainForgetPurge } from "./toolchain/toolchain-forget";
import { createHostToolchain } from "./toolchain/toolchain-host";
import type { createToolchainRouting } from "./toolchain/toolchain-routing";
import { createCodexInspection } from "./web-note/codex-web-note";
import { buildClaudeRunners } from "./work/claude-runners";
import { configureDevelopmentSupervision } from "./work/development-supervision-host";
import type { createDotsMessages } from "./work/dots-messages";
import { createDotsWork } from "./work/dots-work";

type CoreServices = Awaited<ReturnType<typeof buildCore>>;
type HostToolchain = Awaited<
	ReturnType<typeof createHostToolchain>
>["toolchain"];

export function buildKnowledgeService(core: CoreServices, config: Config) {
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

export function buildWorkspaceServices(
	config: Config,
	deps: {
		core: CoreServices;
		scheduler: ReturnType<typeof createScheduler>;
		webResearch: ReturnType<typeof buildWebResearch>;
		getCapabilities: () => Capabilities | null;
		getToolchain: () => HostToolchain;
	},
) {
	const { store, changes, conversation, settings, inference, queue } =
		deps.core;
	const { dbPath } = config;
	const docling = buildDocling(settings, config.larmToken);
	const markdown = buildMarkdown(store, queue, docling, () =>
		changes.publish(),
	);
	const uiCompositions = createUiCompositions();
	const workflow = createAppDevelopmentRuntime({
		store,
		queue,
		scheduler: deps.scheduler,
		markdown,
		scratch: deps.core.scratch,
		web: deps.webResearch,
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
	const ocr = createOcr({
		analyses: buildAnalysisFactory(config, settings, store, queue),
		store,
		queue,
		connection: () => settings.ocrCredentials(),
		inference,
		capabilities: deps.getCapabilities,
	});
	const model3d = buildModel3d(config, { core: deps.core, conversation });
	const video = buildVideo(config, deps.core);
	const compute = buildCompute(config, {
		core: deps.core,
		conversation,
		validChild: (db, child) =>
			deps
				.getToolchain()
				.agents.executions.authorizeChildInTransaction(db, child),
	});
	const browser = buildBrowser(config, {
		core: deps.core,
		settings,
		conversation,
		inference,
		capabilities: deps.getCapabilities,
	});
	const canvas = buildCanvasServices(config, {
		store,
		queue,
		inference,
		conversation,
	});
	return {
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
	};
}

export function registerForgetPurges(deps: {
	memory: ReturnType<typeof createMemoryService>;
	agency: ReturnType<typeof assembleAgency>;
	registeredGoals?: Pick<
		ReturnType<
			typeof import("./agency/registered-goals").createRegisteredGoals
		>,
		"forgetInTransaction"
	>;
	agendaGoalStore: ReturnType<typeof createAgendaGoalStore>;
	noteDocuments: ReturnType<typeof createNoteDocuments>;
	toolchain: HostToolchain;
	knowledge: ReturnType<typeof createKnowledge>;
	webResearch: ReturnType<typeof buildWebResearch>;
	dialogue: ReturnType<typeof createDialogueService>;
}) {
	const { memory } = deps;
	if (deps.registeredGoals)
		memory.registerForgetPurge(deps.registeredGoals.forgetInTransaction);
	memory.registerForgetPurge((db, purge) =>
		forgetGoalDocuments(
			db,
			deps.agendaGoalStore,
			deps.noteDocuments,
			memory.referenceInputs,
			purge,
		),
	);
	memory.registerForgetPurge(
		deps.agency.forgetInTransaction,
		deps.agency.planForgetInTransaction,
	);
	memory.registerForgetPurge(toolchainForgetPurge(deps.toolchain));
	memory.registerForgetPurge((db, purge) =>
		deps.knowledge.forgetSupervisionSourcesInTransaction(db, purge.messageIds),
	);
	// The research runs a dropped TODO named are forgotten once at startup, with the Web research they read.
	deps.dialogue.registerRetiredResearchErase((db, runIds) =>
		forgetPursuitReports(
			db,
			runIds,
			Date.now(),
			(id) => deps.webResearch.forgetInTransaction(db, id),
			(id) => deps.dialogue.revokeExecutionNoticeInTransaction(db, id),
		),
	);
}

export function buildMonitoringService(
	config: Config,
	deps: {
		store: CoreServices["store"];
		settings: CoreServices["settings"];
		inference: CoreServices["inference"];
		queue: CoreServices["queue"];
		activity: CoreServices["activity"];
		media: ReturnType<typeof buildMedia>;
	},
) {
	return createMonitoring({
		remote: createLarmCollector({
			config: () => ({
				baseUrl: deps.settings.get().larm.baseUrl,
				token: config.larmToken,
			}),
			onChange: deps.settings.onChange,
			repository: createLarmRepository(deps.store),
		}),
		settings: deps.settings,
		larmStatus: () => deps.inference.status(),
		attempts: deps.inference.attemptActivity,
		image: deps.media.image.activity,
		music: deps.media.music.activity,
		embedding: deps.activity.embedding,
		judge: deps.activity.judge,
		queue: deps.queue,
		dataDir: dirname(resolve(config.dbPath)),
	});
}

export function buildCanvasServices(
	config: Config,
	deps: {
		store: CoreServices["store"];
		queue: CoreServices["queue"];
		inference: CoreServices["inference"];
		conversation: CoreServices["conversation"];
	},
) {
	const previewOrigin = config.toolchainEnabled
		? canvasPreviewOrigin(config.origin, config.env.EUMENES_CANVAS_PREVIEW_PORT)
		: null;
	const runtime = previewOrigin
		? createCanvasRuntime({
				hostOrigin: config.origin,
				previewOrigin,
				dataDir: join(dirname(config.dbPath), "canvas"),
				store: deps.store,
				inference: deps.inference,
			})
		: null;
	return runtime
		? {
				runtime,
				jobs: createCanvasJobs(
					deps.queue,
					runtime,
					deps.store,
					deps.conversation,
				),
			}
		: undefined;
}

export function buildDialogueService(
	config: Config,
	deps: {
		store: CoreServices["store"];
		settings: CoreServices["settings"];
		changes: CoreServices["changes"];
		conversation: CoreServices["conversation"];
		inference: CoreServices["inference"];
		queue: CoreServices["queue"];
		scheduler: ReturnType<typeof createScheduler>;
		workflow: ReturnType<typeof createAppDevelopmentRuntime>;
		liveBridge: ReturnType<typeof createLiveBridge>;
		resources: ReturnType<typeof buildResources>;
		agency: ReturnType<typeof assembleAgency>;
		webNote: Awaited<ReturnType<typeof createCodexInspection>>;
		media: ReturnType<typeof buildMedia>;
		continuity: ReturnType<typeof createContinuityService>;
		memory: ReturnType<typeof createMemoryService>;
		steward: ReturnType<typeof assembleCuration>["steward"];
		world: ReturnType<typeof assembleCuration>["world"];
		toolchain: Awaited<ReturnType<typeof createHostToolchain>>["toolchain"];
		toolchains: ReturnType<typeof createToolchainRouting> | undefined;
		knowledge: ReturnType<typeof createKnowledge>;
	},
) {
	const enabled = config.toolchainEnabled;
	return createDialogueService({
		debugDiagnostics: {
			enabled: (tx) =>
				deps.settings.inTransaction(tx).agency.debugMode === true,
			onChange: deps.settings.onChange,
			publish: () => deps.changes.publish(),
		},
		diagnostics: createSchedulerDiagnostics({
			scheduler: deps.scheduler,
			queue: deps.queue,
			apps: deps.workflow.apps,
		}),
		externalOutput: deps.liveBridge.externalOutput,
		resources: deps.resources.dialogue,
		agency: deps.agency.dialoguePort,
		memoryTargets: deps.agency.memoryTargets,
		conversationAgent: deps.agency.conversationAgent,
		lookup: createConversationLookup(deps.webNote),
		logFile: () => config.logFile,
		objectRecognition: enabled
			? deps.media.objectRecognition.port(CONVERSATION_DEFAULT_PRINCIPAL)
			: undefined,
		music: enabled ? deps.media.music : undefined,
		image: enabled ? deps.media.image : undefined,
		generatedImages: enabled
			? generatedImageInput(deps.media.image)
			: undefined,
		excalidraw: enabled ? deps.media.drawingOperations : undefined,
		store: deps.store,
		conversation: deps.conversation,
		larm: deps.inference,
		queue: deps.queue,
		continuity: deps.continuity,
		memory: deps.memory,
		steward: deps.steward,
		agents: enabled ? deps.toolchain.agents : undefined,
		...(deps.world ? { worldContext: deps.world.context } : {}),
		...(deps.toolchains
			? {
					toolchains: deps.toolchains,
					specialist: createSpecialistPort({
						routing: deps.toolchains,
						registry: deps.toolchain.registry,
						schemas: deps.toolchain.schemas,
						knowledge: deps.knowledge,
						clock: () => new Date().toISOString(),
					}),
				}
			: {}),
	});
}

export function wireToolchainExecution(deps: {
	goalWorkspaces?: import("./agency/goal-workspaces").GoalWorkspaceRegistry;
	goalAuthority?: NonNullable<
		import("../domains/development-supervision").SupervisionHost["goal"]
	>;
	toolchain: Awaited<ReturnType<typeof createHostToolchain>>["toolchain"];
	toolchains: ReturnType<typeof createToolchainRouting>;
	workflowPorts: ReturnType<
		ReturnType<typeof createAppDevelopmentRuntime>["attach"]
	>;
	settings: CoreServices["settings"];
	browser: ReturnType<typeof buildBrowser>;
	queue: CoreServices["queue"];
	store: CoreServices["store"];
	dialogue: ReturnType<typeof createDialogueService>;
	conversation: CoreServices["conversation"];
	memory: ReturnType<typeof createMemoryService>;
	inference: CoreServices["inference"];
	media: ReturnType<typeof buildMedia>;
	resources: ReturnType<typeof buildResources>;
	markdown: ReturnType<typeof buildMarkdown>;
	knowledge: ReturnType<typeof createKnowledge>;
	goals: ReturnType<typeof assembleCuration>["goals"];
	world: ReturnType<typeof assembleCuration>["world"];
}) {
	const execution = configureTaskExecution({
		settings: deps.settings,
		...deps.workflowPorts,
		webNote: deps.toolchain.webNote,
		claudeCode: deps.toolchain.claudeCode,
		claudeWorkspaceRefs: deps.goalWorkspaces
			?.runnerWorkspaces()
			.map(({ ref }) => ref),
		developmentSupervision: deps.toolchain.developmentSupervision,
		collaboration: deps.toolchain.collaboration,
		interact: deps.browser.interact,
		queue: deps.queue,
		childOperations: deps.toolchain.childOperations,
		store: deps.store,
		capabilities: deps.toolchain.capabilities,
		agents: deps.toolchain.agents,
		routing: deps.toolchains,
		registry: deps.toolchain.registry,
		dialogue: deps.dialogue,
		conversation: deps.conversation,
		memory: deps.memory,
		inference: deps.inference,
		browser: deps.browser.service,
		media: taskMediaPorts({
			image: deps.media.image,
			music: deps.media.music,
			excalidraw: deps.media.drawingOperations,
		}),
		legacy: taskLegacyPorts(deps.dialogue),
		resources: deps.resources.access.registry,
	});
	configureDevelopmentSupervision({
		supervisor: deps.toolchain.developmentSupervision,
		store: deps.store,
		inference: deps.inference,
		execution,
		capabilities: deps.toolchain.capabilities,
		note: deps.toolchain.webNote,
		claude: deps.toolchain.claudeCode,
		markdown: deps.markdown,
		dialogue: deps.dialogue,
		knowledge: deps.knowledge,
		checkout: process.cwd(),
		...(deps.goalWorkspaces ? { goalWorkspaces: deps.goalWorkspaces } : {}),
		...(deps.goalAuthority ? { goal: deps.goalAuthority } : {}),
		context: {
			memory: deps.memory,
			goals: deps.goals.goals,
			...(deps.world
				? {
						world: {
							store: deps.store,
							service: deps.world.service,
							documents: deps.world.documents,
						},
					}
				: {}),
		},
	});
	return execution;
}

export async function buildHostToolchainService(
	config: Config,
	deps: {
		core: CoreServices;
		goalWorkspaces?: import("./agency/goal-workspaces").GoalWorkspaceRegistry;
		workspace: ReturnType<typeof buildWorkspaceServices>;
		lateResources: ReturnType<typeof createLateResources>;
		tasks: Awaited<ReturnType<typeof buildTasks>>;
		dotsMessages: ReturnType<typeof createDotsMessages>;
		webResearch: ReturnType<typeof buildWebResearch>;
		memory: ReturnType<typeof createMemoryService>;
		steward: ReturnType<typeof assembleCuration>["steward"];
		world: ReturnType<typeof assembleCuration>["world"];
		goals: ReturnType<typeof assembleCuration>["goals"];
		scheduler: ReturnType<typeof createScheduler>;
		timers: ReturnType<typeof createTimers>;
		embedder: CoreServices["inference"]["embed"];
		log: ReturnType<typeof getLogger>;
	},
) {
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
	} = deps.core;
	const {
		docling,
		markdown,
		workflow,
		ocr,
		model3d,
		video,
		compute,
		browser,
		canvas,
	} = deps.workspace;
	const webNote = await createCodexInspection(
		config.env,
		config.researchCodexExecutable,
		inference,
	);
	const { claudeRunner, goalClaudeRunners } = await buildClaudeRunners(
		config,
		process.cwd(),
		deps.goalWorkspaces?.runnerWorkspaces() ?? [],
	);
	const { toolchain, links } = await createHostToolchain({
		resources: deps.lateResources,
		canvasAdapter:
			canvas &&
			createCanvasAdapter(
				canvas.runtime,
				canvas.jobs,
				conversation,
				commandInputMessageIdsInTransaction,
			),
		scratch: deps.core.scratch,
		docling,
		dotsWork: createDotsWork({
			tasks: deps.tasks.delegated.tasks,
			reports: deps.tasks.taskReports,
			conversation,
			capabilities: () => toolchain.capabilities,
		}),
		dotsConfiguration: deps.tasks.dots.config,
		dotsMessages: deps.dotsMessages,
		dbPath: config.dbPath,
		store,
		queue,
		appDevelopmentAdapter: workflow.adapter,
		markdown,
		ocr,
		model3d,
		video,
		compute,
		browser,
		inference,
		webResearch: deps.webResearch,
		settings,
		conversation,
		googleAccounts,
		ttsDictionary,
		memory: deps.memory,
		steward: deps.steward,
		world: deps.world,
		goals: deps.goals.goals,
		serviceTests,
		timers: deps.timers,
		schedules: {
			scheduler: deps.scheduler,
			workflowTitle: (db, id) => workflow.apps.app(db, id)?.title,
		},
		log: deps.log,
		history: config.historyToolsEnabled,
		webResearchEnabled: config.webResearchToolsEnabled,
		webNote,
		claudeRunner,
		goalClaudeRunners,
		embed: deps.embedder,
		terminalHooks: {
			baseUrl: `http://${config.host}:${config.port}`,
			publish: () => changes.publish(),
		},
	});
	return { toolchain, links, webNote };
}
