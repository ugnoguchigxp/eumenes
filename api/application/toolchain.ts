import { extendKanbanAdapter } from "./kanban-shared-adapter";
import { createCodexTasksAdapter } from "./codex-tasks-adapter";
import type { createKanbanSdkHost } from "./kanban-sdk-host";
import { createGoogleAccountsAdapter } from "./google-accounts-adapter";
import { createOcrAdapter } from "./ocr-adapter";
import type { SqliteStore } from "../infrastructure/sqlite";
import type { QueueService } from "../domains/queue";
import type { InferencePort } from "../domains/inference";
import {
	webToolArguments,
	type WebResearchService,
} from "../domains/web-research";
import { createCapabilities } from "../domains/capabilities";
import {
	createActionRequests,
	createAdapterRegistry,
	createToolRuntime,
	type ToolAdapter,
} from "../domains/tool-runtime";
import { DEFAULT_TIMER_SCOPE } from "../domains/timers";
import { createAgentRuntime } from "../domains/agent-runtime";
import { createTimerAdapter } from "./timer-adapter";
import {
	createSettingsAdapter,
	publishedSettingsFields,
	type SettingsAdapterPorts,
} from "./settings-adapter";
import { createRecordsAdapter, type RecordsPorts } from "./records-adapter";
import { createMemoryAdapter, type MemoryAdapterPorts } from "./memory-adapter";
import { createStewardAdapter } from "./steward-adapter";
import type { WorldResearchPorts } from "./world-research-ports";
import {
	createWorldAdapter,
	type WorldAdapterPortsLookup,
} from "./world-adapter";
import {
	createServiceTestsAdapter,
	type ServiceTestsPorts,
} from "./service-tests-adapter";
import {
	createTtsDictionaryAdapter,
	type TtsDictionaryPorts,
} from "./tts-dictionary-adapter";
import {
	createInferenceAdapter,
	type InferenceAdapterPorts,
} from "./inference-adapter";
import { createMusicScreenAdapter } from "./music-screen-adapter";
import { createImageScreenAdapter } from "./image-screen-adapter";
import { createUiCompositionsAdapter } from "./ui-compositions-adapter";
import { createObjectRecognitionScreenAdapter } from "./object-recognition-screen-adapter";
import { createTerminalsAdapter } from "./terminals-adapter";
import { createKanbanAdapter } from "./kanban-adapter";
import {
	bundleHostOf,
	createRegistryActions,
	createSchemaProvider,
} from "./toolchain-adapters";
import { createReadPorts } from "./research-history-ports";
import { createToolchainHistory } from "../domains/toolchain-history";
import { createRecipePorts } from "./toolchain-recipes";
import { createVectorRefresh, type Embed } from "./toolchain-vectors";
export async function createToolchain(
	store: SqliteStore,
	queue: QueueService,
	inference: InferencePort,
	web: WebResearchService,
	options: {
		dots?: boolean;
		kanbanSdk?: ReturnType<typeof createKanbanSdkHost>;
		music?: boolean;
		image?: boolean;
		uiCompositions?: import("../domains/ui-compositions").UiCompositionsService;
		objectRecognition?: boolean;
		ocr?: import("../domains/ocr").OcrService;
		/** PTY sessions for the terminal screen (absent: not offered). */
		terminals?: import("../domains/terminals").TerminalsService;
		/** The task board (needs `terminals` for its runs). */
		kanban?: import("../domains/kanban").KanbanService;
		excalidraw?: boolean;
		history?: boolean;
		/** LARM embedding provider; without it retrieval uses full-text search only. */
		embed?: Embed;
		webResearch?: boolean;
		conversation?: import("../domains/conversation").ConversationService;
		timers?: import("../domains/timers").TimersService;
		/** Tests that observe a pass immediately after a commit set 0. */
		reconcileThrottleMs?: number;
		/** Settings service for the data-driven settings screens (absent: no settings adapter). */
		googleAccounts?: import("../domains/google-accounts").GoogleAccounts;
		settings?: SettingsAdapterPorts;
		/** Domain readers for the data-driven records screen (absent: no records adapter). */
		records?: Omit<RecordsPorts, "history">;
		/** Inference service for the data-driven connection checks (needs `settings` too). */
		inference?: InferenceAdapterPorts;
		/** The reading dictionary for the data-driven 読み方辞書 screen (absent: not offered). */
		ttsDictionary?: TtsDictionaryPorts;
		/** The 記憶 screen (memory and continuity services). */
		memory?: MemoryAdapterPorts;
		/** The conversation agent's `memory_request` tool (absent: not offered). */
		steward?: {
			service: Parameters<typeof createStewardAdapter>[0];
			memory: Parameters<typeof createStewardAdapter>[1];
		};
		/** The World investigation's reads (`world.find`, `world.query`), built over the agent runtime; the toolchain is offered only while World is usable. */
		worldResearch?: (
			runtime: () => import("../domains/agent-runtime").AgentRuntime,
		) => WorldResearchPorts;
		/** Messages memory forbids reusing; history reads drop them (absent: nothing is dropped). */
		blockedMessages?: Parameters<typeof createReadPorts>[3];
		/** The World screen; the lookup returns undefined while World is OFF. */
		world?: WorldAdapterPortsLookup;
		/** The 動作確認 screen. */
		serviceTests?: ServiceTestsPorts;
		/** Key for HMAC digests of secret-bearing UI actions (absent: such actions are refused). */
		secretKey?: () => Uint8Array | undefined;
		/** Open toolchain interactions for the timer question source (dialogue, created later). */
		interactions?: NonNullable<
			Parameters<typeof createTimerAdapter>[1]
		>["interactions"];
	} = {},
) {
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
			},
		);
	// Typed domain adapters this host offers; bundles naming any other adapter are not registered.
	const registry = createAdapterRegistry([
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
		...(options.googleAccounts
			? [createGoogleAccountsAdapter(options.googleAccounts)]
			: []),
		...(options.music ? [createMusicScreenAdapter()] : []),
		...(options.image ? [createImageScreenAdapter()] : []),
		...(options.uiCompositions
			? [createUiCompositionsAdapter(options.uiCompositions)]
			: []),
		...(options.ocr ? [createOcrAdapter(options.ocr)] : []),
		...(options.objectRecognition
			? [createObjectRecognitionScreenAdapter()]
			: []),
		...(options.terminals ? [createTerminalsAdapter(options.terminals)] : []),
		...(options.kanban && options.terminals
			? [
					createKanbanAdapter(options.kanban, {
						runnable: () => options.terminals!.trackable(),
					}),
				]
			: []),
		...(options.timers
			? [
					createTimerAdapter(options.timers, {
						interactions: options.interactions,
					}),
				]
			: []),
		...(options.settings
			? [
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
		...(options.steward
			? [createStewardAdapter(options.steward.service, options.steward.memory)]
			: []),
		...(options.world ? [createWorldAdapter(options.world)] : []),
		...(options.serviceTests
			? [createServiceTestsAdapter(options.serviceTests)]
			: []),
	]);
	const capabilities = createCapabilities(
		store,
		new Set([
			...(options.webResearch !== false ? ["web"] : []),
			...(options.timers ? ["timer"] : []),
			...(options.dots ? ["dots"] : []),
			...(options.music ? ["music"] : []),
			...(options.image ? ["image"] : []),
			...(options.uiCompositions ? ["ui-compositions"] : []),
			...(options.objectRecognition ? ["object-recognition"] : []),
			...(options.terminals ? ["claude-code"] : []),
			...(options.kanban && options.terminals ? ["kanban"] : []),
			...(options.kanbanSdk ? ["codex-tasks"] : []),
			...(options.steward ? ["steward"] : []),
			...(options.worldResearch ? ["world-query"] : []),
			...(options.ocr ? ["ocr"] : []),
			...(options.excalidraw ? ["excalidraw"] : []),
			...(options.conversation && options.history !== false ? ["history"] : []),
		]),
		{ bundleHost: () => bundleHostOf(registry) },
	);
	await capabilities.seed();
	const history = createToolchainHistory(store);
	const reads = createReadPorts(
		web,
		options.history === false ? undefined : options.conversation,
		() => agents,
		options.blockedMessages,
	);
	const recipes = createRecipePorts(
		history,
		() => agents,
		() => tools,
	);
	const world = options.worldResearch?.(() => agents);
	const worldPorts = () => {
		if (!world) throw new Error("capability_unavailable");
		return world;
	};
	const adapter: ToolAdapter = {
		...reads,
		operationFingerprintInTransaction(db, r) {
			return r.tool.backend === "world-query"
				? worldPorts().operationFingerprintInTransaction?.(db, r)
				: reads.operationFingerprintInTransaction!(db, r);
		},
		localInTransaction(db, r) {
			return r.tool.id === "recipe.find"
				? recipes.findInTransaction(db, r)
				: r.tool.backend === "world-query"
					? worldPorts().localInTransaction!(db, r)
					: reads.localInTransaction!(db, r);
		},
		// World readings are checked against the World; every other source against the reads.
		validateEvidenceInTransaction(db, owner, sources, proofs) {
			const readings = sources.filter(
				(s) => s.kind !== "world_claim" && s.kind !== "world_document",
			);
			return (
				reads.validateEvidenceInTransaction!(db, owner, readings, proofs) &&
				(readings.length === sources.length ||
					(world?.validateEvidenceInTransaction?.(db, owner, sources, []) ??
						false))
			);
		},
		startInTransaction(db, r) {
			const raw = webToolArguments(
				r.tool.id,
				r.arguments as Record<string, unknown>,
				r.requestId,
			);
			if (raw.operation === "read")
				raw.source = tools
					.observationsInTransaction(db, r.owner.taskId)
					.flatMap((o) => o.sources)
					.filter((s) => s.basis === "snippet" && s.url === raw.url && s.source)
					.at(-1)?.source;
			const op = web.submitInTransaction(db, raw, {
				deadlineAtMs: r.deadline,
				parentJobId: r.parentJobId,
				lane: "background",
				attemptTimeoutMs: r.attemptTimeoutMs,
			});
			return { operationId: op.runId, jobId: op.jobId };
		},
		get(id) {
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
			web.cancelInTransaction(db, id, "cancel_requested"),
	};
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
	const agents = createAgentRuntime({
		store,
		capabilities,
		tools,
		queue,
		inference,
		reconcileThrottleMs: options.reconcileThrottleMs,
		onSearchReport: recipes.onSearchReport,
	});
	const vectors = createVectorRefresh(
		store,
		capabilities,
		history,
		options.embed,
	);
	return {
		capabilities,
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
		/** World is usable now (the World investigation is offered only then); absent: never. */
		worldAvailable: world?.available,
		tools,
		agents,
		history,
		/** Embed passages that have no vector in the provider's current space. */
		refreshVectors: vectors.refresh,
		/** Embed one request for retrieval; undefined when embedding is unavailable or slow. */
		embedQuery: vectors.embedQuery,
	};
}
