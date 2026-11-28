import type { Database } from "bun:sqlite";
import {
	createWebNote,
	type WebNoteDeps,
	type WebNoteService,
} from "../../domains/web-note";
import {
	createClaudeCode,
	type ClaudeCodeService,
	type Runner as ClaudeRunner,
} from "../../domains/claude-code";
import { createDevelopmentSupervision } from "../../domains/development-supervision";
import { createSupervisionAdapter } from "../work/supervision-adapter";
import { createClaudeCodeTaskAdapter } from "../work/claude-code-task-adapter";
import { createWebNoteAdapters } from "../web-note/web-note-adapter";
import { createMarkdownAdapter } from "../markdown/markdown-adapter";
import { createArchiveResearchAdapter } from "../markdown/archive-research-adapter";
import {
	createArchiveResearchTools,
	isArchiveResearchOperation,
} from "../markdown/archive-research-tools";
import { createDoclingAdapter } from "../docling/docling-adapter";
import { createDotsMessagingAdapter } from "../work/dots-messaging-adapter";
import { createDotsDelegationAdapter } from "../work/dots-delegation-adapter";
import {
	autonomousResearchSource,
	autonomousActionSource,
	readActionOriginInTransaction,
} from "../../domains/dialogue";
import { createChildOperations } from "./child-operations";
import { extendKanbanAdapter } from "../work/kanban-shared-adapter";
import { createCodexTasksAdapter } from "../work/codex-tasks-adapter";
import type { createKanbanSdkHost } from "../work/kanban-sdk-host";
import { createGoogleAccountsAdapter } from "../settings/google-accounts-adapter";
import { createOcrAdapter } from "../media/ocr-adapter";
import { createComputeAdapter } from "../compute/compute-adapter";
import { createModel3dAdapter } from "../media/model3d-adapter";
import { createBrowserAdapter } from "../browser/browser-adapter";
import { createInteractAdapter } from "../browser/interact-adapter";
import { createTaskAdapter } from "./task-execution-adapter";
import { createPipelinesAdapter } from "../pipelines/pipelines-adapter";
import { createCollaborationHost } from "../collaboration/collaboration-host";
import type { BrowserAssembly } from "../browser/browser-composition";
import type { SqliteStore } from "../../infrastructure/sqlite";
import type { QueueService } from "../../domains/queue";
import type { InferencePort } from "../../domains/inference";
import {
	webToolArguments,
	type WebResearchService,
} from "../../domains/web-research";
import { createCapabilities, hash } from "../../domains/capabilities";
import {
	createActionRequests,
	createAdapterRegistry,
	createToolRuntime,
	type ToolAdapter,
} from "../../domains/tool-runtime";
import { DEFAULT_TIMER_SCOPE } from "../../domains/timers";
import { createAgentRuntime } from "../../domains/agent-runtime";
import { createTimerAdapter } from "../timers/timer-adapter";
import type { SchedulerAdapterPorts } from "../scheduler/scheduler-adapter";
import {
	createSettingsAdapter,
	publishedSettingsFields,
	type SettingsAdapterPorts,
} from "../settings/settings-adapter";
import {
	createRecordsAdapter,
	type RecordsPorts,
} from "../settings/records-adapter";
import {
	createMemoryAdapter,
	type MemoryAdapterPorts,
} from "../world/memory-adapter";
import { createStockAdapter } from "../stock/stock-adapter";
import { createWeatherAdapter } from "../weather/weather-adapter";
import type { WorldResearchPorts } from "../world/world-research-ports";
import {
	createWorldAdapter,
	type WorldAdapterPortsLookup,
} from "../world/world-adapter";
import {
	createServiceTestsAdapter,
	type ServiceTestsPorts,
} from "../settings/service-tests-adapter";
import {
	createTtsDictionaryAdapter,
	type TtsDictionaryPorts,
} from "../settings/tts-dictionary-adapter";
import {
	createInferenceAdapter,
	type InferenceAdapterPorts,
} from "../settings/inference-adapter";
import { createVideoAdapter } from "../media/video-adapter";
import { createMusicScreenAdapter } from "../media/music-screen-adapter";
import { createImageScreenAdapter } from "../media/image-screen-adapter";
import { createUiCompositionsAdapter } from "../media/ui-compositions-adapter";
import { createObjectRecognitionScreenAdapter } from "../media/object-recognition-screen-adapter";
import { createShellAdapter } from "../shell/shell-adapter";
import { createTerminalsAdapter } from "../work/terminals-adapter";
import { createKanbanAdapter } from "../work/kanban-adapter";
import {
	bundleHostOf,
	createRegistryActions,
	createSchemaProvider,
} from "./toolchain-adapters";
import { createReadPorts } from "./research-history-ports";
import { createToolchainHistory } from "../../domains/toolchain-history";
import { createVectorRefresh, type Embed } from "./toolchain-vectors";
type ToolchainOptions = {
	canvasAdapter?: import("../../domains/tool-runtime").DomainAdapter;
	docling?: import("../../domains/docling").DoclingService;
	dotsWork?: import("../work/dots-work").DotsWork;
	dotsConfiguration?: import("../work/dots-tasks").DotsTasks["config"];
	dotsMessages?: import("../work/dots-messages").DotsMessages;
	dots?: boolean;
	kanbanSdk?: ReturnType<typeof createKanbanSdkHost>;
	music?: boolean;
	image?: boolean;
	markdown?: import("../../domains/markdown").MarkdownService;
	appDevelopmentAdapter?: import("../../domains/tool-runtime").DomainAdapter;
	uiCompositions?: import("../../domains/ui-compositions").UiCompositionsService;
	/** Whether a specialist session still owns its work (UI undo/redo/save guard). */
	specialistSessionLive?: (
		tx: import("bun:sqlite").Database,
		sessionId: string,
	) => boolean;
	objectRecognition?: boolean;
	ocr?: import("../../domains/ocr").OcrService;
	compute?: import("../../domains/compute").ComputeService;
	model3d?: import("../../domains/model3d").Model3dService;
	video?: import("../../domains/video").VideoService;
	/** Brave tabs and local captures (absent: not offered). */
	browser?: Pick<BrowserAssembly, "service" | "effects" | "requests"> &
		Partial<Pick<BrowserAssembly, "interact">>;
	/** PTY sessions for the terminal screen (absent: not offered). */
	shell?: import("../../domains/shell").ShellService;
	terminals?: import("../../domains/terminals").TerminalsService;
	/** The task board (needs `terminals` for its runs). */
	kanban?: import("../../domains/kanban").KanbanService;
	excalidraw?: boolean;
	history?: boolean;
	/** LARM embedding provider; without it retrieval uses full-text search only. */
	embed?: Embed;
	webResearch?: boolean;
	/**
	 * The research note task (Codex's own web search): one Codex turn and the ledger record of it. Absent: the task is
	 * not offered.
	 */
	webNote?: Pick<WebNoteDeps, "turn" | "record" | "inspectSource">;
	claudeRunner?: ClaudeRunner;
	worksEnabled?: boolean;
	claudeProtectedPaths?: readonly string[];
	goalClaudeRunners?: ReadonlyMap<string, ClaudeRunner>;
	conversation?: import("../../domains/conversation").ConversationService;
	timers?: import("../../domains/timers").TimersService;
	schedules?: SchedulerAdapterPorts;
	/** Tests that observe a pass immediately after a commit set 0. */
	reconcileThrottleMs?: number;
	/** Settings service for the data-driven settings screens (absent: no settings adapter). */
	googleAccounts?: import("../../domains/google-accounts").GoogleAccounts;
	settings?: SettingsAdapterPorts;
	/** Domain readers for the data-driven records screen (absent: no records adapter). */
	records?: Omit<RecordsPorts, "history">;
	/** Inference service for the data-driven connection checks (needs `settings` too). */
	inference?: InferenceAdapterPorts;
	/** The reading dictionary for the data-driven 読み方辞書 screen (absent: not offered). */
	ttsDictionary?: TtsDictionaryPorts;
	/** The 記憶 screen (memory and continuity services). */
	memory?: MemoryAdapterPorts;
	/** The weather toolchain's adapter and the forecast service it reads (absent: not offered). */
	weather?: { fetch?: typeof fetch; now?: () => number };
	/** The stock toolchain's adapter and the services it reads (absent: not offered). */
	stock?: { fetch?: typeof fetch; now?: () => number };
	/** The sub-agents' `resource.read` (absent: it is not offered). */
	resources?: import("../resources/late").LateResources;
	/** The sub-agents' `scratch.write` (absent: it is not offered). */
	sharedWrite?: import("../../domains/agent-runtime").SharedWritePort;
	/** The conversation's shared files, which 3D generation may start from (absent: none). */
	scratch?: import("../../domains/scratch").ScratchStore;
	/** The World investigation's reads (`world.find`, `world.query`), built over the agent runtime; the toolchain is offered only while World is usable. */
	worldResearch?: (
		runtime: () => import("../../domains/agent-runtime").AgentRuntime,
	) => WorldResearchPorts;
	/** Messages memory forbids reusing; history reads drop them (absent: nothing is dropped). */
	blockedMessages?: Parameters<typeof createReadPorts>[3];
	/** The World screen; the lookup returns undefined while World is OFF. */
	world?: WorldAdapterPortsLookup;
	/** The 動作確認 screen. */
	serviceTests?: ServiceTestsPorts;
	/** Key for HMAC digests of secret-bearing UI actions (absent: such actions are refused). */
	secretKey?: () => Uint8Array | undefined;
};

/**
 * The saved user request a research tool call stands on: the execution's source, else the run's own action origin.
 * A forgotten or missing message refuses the call.
 */
function researchSourceResolver(
	agents: () => import("../../domains/agent-runtime").AgentRuntime,
	options: Pick<ToolchainOptions, "browser" | "blockedMessages">,
) {
	return (
		db: import("bun:sqlite").Database,
		owner: import("../../domains/capabilities").Owner,
	) => {
		const autonomous = autonomousResearchSource(
			db,
			owner.rootRunId,
			Date.now(),
		);
		if (autonomous) return { ...autonomous, digest: hash(autonomous.request) };
		const origin =
			agents().executionOriginInTransaction(db, owner)?.source ??
			readActionOriginInTransaction(db, owner.rootRunId);
		if (origin && "origin" in origin && origin.origin === "autonomous") {
			const current = autonomousActionSource(db, origin.runId, Date.now());
			if (!current) throw new Error("source_ref_invalid");
			return current;
		}
		const request =
			origin?.messageId &&
			options.browser?.requests.userMessageInTransaction(db, origin.messageId);
		if (
			!origin?.messageId ||
			!request ||
			options.blockedMessages?.blockedMessageIdsInTransaction(db, [
				origin.messageId,
			]).size
		)
			throw new Error("source_ref_invalid");
		return {
			conversationId: origin.conversationId,
			messageId: origin.messageId,
			runId: origin.runId,
			request,
			digest: hash(request),
		};
	};
}

const autonomousResearchAllowed = (db: Database, root: string) =>
	autonomousResearchSource(db, root, Date.now()) !== null;

const createResearchRuntime = (
	deps: Parameters<typeof createAgentRuntime>[0],
) =>
	createAgentRuntime({
		...deps,
		autonomousResearch: autonomousResearchAllowed,
	});

/** Backends enabled by the host's available service ports. */
function enabledBackends(options: ToolchainOptions) {
	return new Set([
		...(options.docling ? ["docling"] : []),
		...(options.canvasAdapter ? ["canvas"] : []),
		...(options.markdown ? ["markdown", "development-supervision"] : []),
		"task-execution",
		...(options.webNote?.turn ? ["web-note"] : []),
		...(options.webNote?.inspectSource ? ["inspect-source"] : []),
		...(options.webResearch !== false ? ["web"] : []),
		...(options.timers ? ["timer"] : []),
		...(options.dots ? ["dots"] : []),
		...(options.music ? ["music"] : []),
		...(options.image ? ["image"] : []),
		...(options.appDevelopmentAdapter ? ["app-development"] : []),
		...(options.uiCompositions ? ["ui-compositions"] : []),
		...(options.objectRecognition ? ["object-recognition"] : []),
		...(options.shell ? ["shell"] : []),
		...(options.terminals || options.worksEnabled ? ["claude-code"] : []),
		...(options.kanban && options.terminals ? ["kanban"] : []),
		...(options.kanbanSdk ? ["codex-tasks"] : []),
		...(options.weather ? ["weather"] : []),
		...(options.stock ? ["stock"] : []),
		...(options.worldResearch ? ["world-query"] : []),
		...(options.ocr ? ["ocr"] : []),
		...(options.model3d ? ["model3d"] : []),
		...(options.video ? ["video"] : []),
		...(options.compute ? ["compute"] : []),
		...(options.browser ? ["browser"] : []),
		...(options.excalidraw ? ["excalidraw"] : []),
		...(options.conversation && options.history !== false ? ["history"] : []),
	]);
}

async function seedToolchainCapabilities(
	store: SqliteStore,
	registry: ReturnType<typeof createAdapterRegistry>,
	options: ToolchainOptions,
) {
	const capabilities = createCapabilities(store, enabledBackends(options), {
		bundleHost: () =>
			bundleHostOf(
				registry
					.all()
					.filter(
						(adapter) =>
							adapter.ref !== "adapter:claude-code-task@1" ||
							options.claudeRunner?.ready() ||
							!!options.goalClaudeRunners?.size,
					),
			),
	});
	await capabilities.seed();
	return capabilities;
}

export async function createToolchain(
	store: SqliteStore,
	queue: QueueService,
	inference: InferencePort,
	web: WebResearchService,
	options: ToolchainOptions = {},
) {
	let webNoteRuntime: WebNoteService | undefined;
	let claudeCode: ClaudeCodeService | undefined;
	let supervision: ReturnType<typeof createDevelopmentSupervision> | undefined;
	let taskRuntime:
		import("../../domains/agent-runtime").AgentRuntime | undefined;
	const shared =
		options.kanbanSdk &&
		extendKanbanAdapter(
			createKanbanAdapter(options.kanbanSdk.kanban, {
				runnable: options.kanbanSdk.terminals.trackable,
			}),
			{
				kanban: options.kanbanSdk.kanban,
				registry: options.kanbanSdk.registry,
				activity: options.kanbanSdk.activity,
				supervision: () => supervision,
			},
		);
	const weather = options.weather && createWeatherAdapter(options.weather);
	const stock = options.stock && createStockAdapter(options.stock);
	// Typed domain adapters this host offers; bundles naming any other adapter are not registered.
	const collaboration = createCollaborationHost(queue, options.schedules);
	const registry = createAdapterRegistry([
		...collaboration.adapters,
		...(options.markdown ? [createMarkdownAdapter(options.markdown)] : []),
		...(options.markdown
			? [createArchiveResearchAdapter(options.markdown, () => taskRuntime)]
			: []),
		...(options.docling ? [createDoclingAdapter(options.docling)] : []),
		...(options.canvasAdapter ? [options.canvasAdapter] : []),
		createTaskAdapter(() => taskRuntime),
		...createWebNoteAdapters(() => webNoteRuntime),
		createClaudeCodeTaskAdapter(() => claudeCode),
		...(options.worksEnabled
			? [createClaudeCodeTaskAdapter(() => claudeCode, true)]
			: []),
		createSupervisionAdapter(() => supervision),
		createPipelinesAdapter(() => taskRuntime),
		...(shared && options.kanbanSdk
			? [
					shared,
					createCodexTasksAdapter({
						tasks: options.kanbanSdk.tasks,
						kanban: options.kanbanSdk.kanban,
						shared,
						allowed: options.kanbanSdk.allowed,
						settingsSource: (tx) => ({
							settings: options.kanbanSdk!.tasks.settingsInTransaction(tx),
							allowed: options.kanbanSdk!.allowed(),
							resources: options.kanbanSdk!.resources(tx),
						}),
					}),
				]
			: []),
		...(options.dotsMessages
			? [createDotsMessagingAdapter(options.dotsMessages)]
			: []),
		...(options.dotsWork && options.dotsConfiguration
			? [
					createDotsDelegationAdapter(
						options.dotsWork,
						() => capabilities,
						options.dotsConfiguration,
					),
				]
			: []),
		...(options.googleAccounts
			? [createGoogleAccountsAdapter(options.googleAccounts)]
			: []),
		...(options.music ? [createMusicScreenAdapter()] : []),
		...(options.video ? [createVideoAdapter(options.video)] : []),
		...(options.image ? [createImageScreenAdapter()] : []),
		...(options.appDevelopmentAdapter ? [options.appDevelopmentAdapter] : []),
		...(options.uiCompositions
			? [
					createUiCompositionsAdapter(options.uiCompositions, {
						sessionLive: options.specialistSessionLive,
					}),
				]
			: []),
		...(options.ocr ? [createOcrAdapter(options.ocr)] : []),
		...(options.model3d
			? [createModel3dAdapter(options.model3d, options.scratch)]
			: []),
		...(options.compute ? [createComputeAdapter(options.compute)] : []),
		...(options.browser
			? [
					createBrowserAdapter(
						options.browser.service,
						options.browser.effects,
						options.browser.requests,
					),
					...(options.browser.interact
						? [
								createInteractAdapter(
									options.browser.interact,
									options.browser.requests,
								),
							]
						: []),
				]
			: []),
		...(options.objectRecognition
			? [createObjectRecognitionScreenAdapter()]
			: []),
		...(options.shell ? [createShellAdapter(options.shell)] : []),
		...(options.terminals ? [createTerminalsAdapter(options.terminals)] : []),
		...(options.kanban && options.terminals
			? [
					createKanbanAdapter(options.kanban, {
						runnable: () => options.terminals!.trackable(),
					}),
				]
			: []),
		...(options.timers ? [createTimerAdapter(options.timers)] : []),
		...(options.settings
			? [
					createUsageAdapter(options.settings),
					createSettingsAdapter(options.settings, {
						fields: publishedSettingsFields(() => capabilities),
					}),
				]
			: []),
		...(options.records
			? [createRecordsAdapter({ ...options.records, history: () => history })]
			: []),
		...(options.inference && options.settings
			? [createInferenceAdapter(options.inference, options.settings)]
			: []),
		...(options.ttsDictionary
			? [createTtsDictionaryAdapter(options.ttsDictionary)]
			: []),
		...(options.memory ? [createMemoryAdapter(options.memory)] : []),
		...(options.world ? [createWorldAdapter(options.world)] : []),
		...(weather ? [weather] : []),
		...(stock ? [stock] : []),
		...(options.serviceTests
			? [createServiceTestsAdapter(options.serviceTests)]
			: []),
	]);
	const capabilities = await seedToolchainCapabilities(
		store,
		registry,
		options,
	);
	const taskDeps = { store, queue, capabilities };
	supervision = createDevelopmentSupervision({ ...taskDeps, inference });
	webNoteRuntime = createWebNote({ ...taskDeps, ...options.webNote });
	claudeCode = createClaudeCode({
		...taskDeps,
		inference,
		runner: options.claudeRunner,
		goalRunners: options.goalClaudeRunners,
		root: process.cwd(),
		protectedPaths: options.claudeProtectedPaths,
	});
	const history = createToolchainHistory(store);
	const reads = createReadPorts(
		web,
		options.history === false ? undefined : options.conversation,
		() => agents,
		options.blockedMessages,
	);
	const world = options.worldResearch?.(() => agents);
	const worldPorts = () => {
		if (!world) throw new Error("capability_unavailable");
		return world;
	};
	const researchSource = researchSourceResolver(() => agents, options);
	const children =
		options.browser &&
		createChildOperations(
			options.browser.service,
			(db, caller) => {
				if (caller?.kind === "execution")
					return agents.executions.authorizeChildInTransaction(
						db,
						caller.child,
					);
				if (caller?.kind !== "research") return false;
				try {
					agents.authorizeReadOwnerInTransaction(db, caller.owner, "read");
					if (hash(researchSource(db, caller.owner)) !== hash(caller.source))
						return false;
					const inv = tools.getInTransaction(db, caller.invocationId);
					return (
						!!inv &&
						inv.state === "pending" &&
						inv.owner_task_id === caller.owner.taskId &&
						inv.root_run_id === caller.owner.rootRunId &&
						inv.cancel_epoch === caller.owner.cancelEpoch &&
						inv.deadline > Date.now()
					);
				} catch {
					return false;
				}
			},
			(db, caller, reservationId) =>
				caller.kind === "research"
					? agents.reserveExecutionCallsInTransaction(
							db,
							caller.owner,
							reservationId,
						)
					: caller.child.modelCalls,
		);
	configureResearchReview(options.browser, web);

	const adapter = researchToolAdapter({
		archive:
			options.markdown &&
			createArchiveResearchTools(queue, options.markdown.research),
		reads,
		world,
		worldPorts,
		web,
		options,
		children,
		researchSource,
		tools: () => tools,
	});

	const actions = registry.all().length
		? createRegistryActions(registry, () => agents)
		: undefined;
	const tools = createToolRuntime(
		store,
		capabilities,
		queue,
		adapter,
		Date.now,
		actions,
	);
	const agents = createResearchRuntime({
		store,
		capabilities,
		tools,
		queue,
		inference,
		reconcileThrottleMs: options.reconcileThrottleMs,
		...(options.resources ? { resources: options.resources.read } : {}),
		...(options.sharedWrite ? { sharedWrite: options.sharedWrite } : {}),
	});
	taskRuntime = agents;
	const vectors = createVectorRefresh(store, capabilities, options.embed);
	return {
		capabilities,
		webNote: webNoteRuntime,
		developmentSupervision: supervision,
		claudeCode,
		collaboration,
		childOperations: children,
		registry,
		/** UI actions of registered artifacts: acceptance, execution and receipt in one write. */
		actionRequests: createActionRequests({
			store,
			capabilities,
			registry,
			// The only host scope until per-user scopes exist (design §8).
			scope: options.timers?.scope ?? DEFAULT_TIMER_SCOPE,
			// Secret-bearing UI actions are matched by HMAC under a settings-derived key.
			secretKey: options.secretKey,
			// `authority_epoch` of an acceptance row is the host's authority epoch. The host has a
			// single owner and no revocation yet, so the ledger's default (0) is the whole truth;
			// a per-user scope would pass its own `authorityEpoch` here.
		}),
		schemas: createSchemaProvider(capabilities),
		/** Keeps the weather toolchain's list of forecast areas read (absent: no weather toolchain). */
		weather: weather && { maintain: weather.maintain },
		/** Keeps the stock toolchain's list of listed companies read (absent: no stock toolchain). */
		stock: stock && { maintain: stock.maintain },
		/** World is usable now (the World investigation is offered only then); absent: never. */
		worldAvailable: world?.available,
		tools,
		agents,
		history,
		/** Embed passages that have no vector in the provider's current space. */
		refreshVectors: vectors.refresh,
		/** Embed passages outside the index (a draft's trial); undefined when embedding is unavailable. */
		embedPassages: vectors.embedPassages,
		/** Embed one request for retrieval; undefined when embedding is disabled. */
		embedQuery: vectors.embedQuery,
	};
}

function researchToolAdapter(deps: {
	archive?: ReturnType<typeof createArchiveResearchTools>;
	reads: ReturnType<typeof createReadPorts>;
	world: ReturnType<NonNullable<ToolchainOptions["worldResearch"]>> | undefined;
	worldPorts: () => ReturnType<NonNullable<ToolchainOptions["worldResearch"]>>;
	web: WebResearchService;
	options: ToolchainOptions;
	children: ReturnType<typeof createChildOperations> | undefined;
	researchSource: (
		db: import("bun:sqlite").Database,
		owner: import("../../domains/capabilities").Owner,
	) => Extract<
		import("../../domains/tool-runtime").ChildCaller,
		{ kind: "research" }
	>["source"];
	tools: () => ReturnType<typeof createToolRuntime>;
}): ToolAdapter {
	const {
		reads,
		world,
		worldPorts,
		web,
		options,
		children,
		researchSource,
		archive,
	} = deps;
	return {
		...reads,
		releaseTask(id) {
			reads.releaseTask?.(id);
			archive?.releaseTask(id);
			options.browser?.service.releaseResearchOwner(id);
		},
		operationFingerprintInTransaction(db, r) {
			return r.tool.backend === "world-query"
				? worldPorts().operationFingerprintInTransaction?.(db, r)
				: reads.operationFingerprintInTransaction!(db, r);
		},
		localInTransaction(db, r) {
			return r.tool.backend === "world-query"
				? worldPorts().localInTransaction!(db, r)
				: reads.localInTransaction!(db, r);
		},
		// World readings are checked against the World; every other source against the reads.
		validateEvidenceInTransaction(db, owner, sources, proofs) {
			const readings = sources.filter(
				(s) => s.kind !== "world_claim" && s.kind !== "world_document",
			);
			const archived = readings.filter((s) => s.kind === "archive_document");
			return (
				reads.validateEvidenceInTransaction!(db, owner, readings, proofs) &&
				(!archived.length || !!archive?.validate(archived)) &&
				(readings.length === sources.length ||
					(world?.validateEvidenceInTransaction?.(db, owner, sources, []) ??
						false))
			);
		},
		startInTransaction(db, r) {
			if (r.tool.backend === "markdown") {
				if (!archive) throw new Error("markdown_archive_unavailable");
				return archive.startInTransaction(db, r);
			}
			if (r.tool.id === "browser.research") {
				if (!children) throw new Error("capability_unavailable");
				const args = r.arguments as { request: string; url?: string };
				return children.startInTransaction(db, {
					caller: {
						kind: "research",
						owner: r.owner,
						invocationId: r.invocationId,
						source: researchSource(db, r.owner),
					},
					requestId: r.requestId,
					...args,
					deadline: r.deadline,
					parentJobId: r.parentJobId,
				});
			}
			const raw = webToolArguments(
				r.tool.id,
				r.arguments as Record<string, unknown>,
				r.requestId,
			);
			if (raw.operation === "read")
				raw.source = deps
					.tools()
					.liveSourcesInTransaction(db, r.owner.taskId)
					.filter((s) => s.basis === "snippet" && s.url === raw.url && s.source)
					.at(-1)?.source;
			const op = web.submitInTransaction(db, raw, {
				deadlineAtMs: r.deadline,
				parentJobId: r.parentJobId,
				lane: "background",
				attemptTimeoutMs: r.attemptTimeoutMs,
				availableAtMs: r.availableAtMs,
			});
			return { operationId: op.runId, jobId: op.jobId };
		},
		get(id) {
			if (isArchiveResearchOperation(id)) return archive?.get(id) ?? null;
			if (id.startsWith("browser-child:")) return children?.get(id) ?? null;
			const run = web.get(id);
			if (!run) return null;
			return {
				state:
					run.status === "queued" || run.status === "running"
						? "pending"
						: run.status === "completed"
							? "succeeded"
							: run.status,
				result: run.result ?? undefined,
				errorCode: run.resultExpired
					? "result_expired"
					: (run.errorCode ?? undefined),
			};
		},
		cancelInTransaction: (db, id) =>
			isArchiveResearchOperation(id)
				? (archive?.cancelInTransaction(db, id) ?? [])
				: id.startsWith("browser-child:")
					? (children?.cancelInTransaction(db, id) ?? [])
					: web.cancelInTransaction(db, id, "cancel_requested"),
	};
}

function configureResearchReview(
	browser: ToolchainOptions["browser"],
	web: WebResearchService,
) {
	browser?.service.setResearchReview((page, signal) =>
		web.reviewCollected({
			source: {
				kind: "web",
				trust: "untrusted",
				url: page.url,
				provider: "browser",
				retrievedAt: page.fetchedAt,
			},
			requestedUse:
				page.purpose === "facts" ? "answer_with_citation" : "search_more",
			segments: [
				{
					location: "visible",
					text: JSON.stringify({
						title: page.title,
						text: page.text,
						links: page.links,
					}),
				},
			],
			findings: [],
			signal,
		}),
	);
}
import { createUsageAdapter } from "../usage/usage-adapter";
