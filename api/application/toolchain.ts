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
		music?: boolean;
		image?: boolean;
		uiCompositions?: import("../domains/ui-compositions").UiCompositionsService;
		objectRecognition?: boolean;
		/** PTY sessions for the terminal screen (absent: not offered). */
		terminals?: import("../domains/terminals").TerminalsService;
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
		settings?: SettingsAdapterPorts;
		/** Domain readers for the data-driven records screen (absent: no records adapter). */
		records?: Omit<RecordsPorts, "history">;
		/** Inference service for the data-driven connection checks (needs `settings` too). */
		inference?: InferenceAdapterPorts;
		/** The reading dictionary for the data-driven 読み方辞書 screen (absent: not offered). */
		ttsDictionary?: TtsDictionaryPorts;
		/** The 記憶 screen (memory and continuity services). */
		memory?: MemoryAdapterPorts;
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
	// Typed domain adapters this host offers; bundles naming any other adapter are not registered.
	const registry = createAdapterRegistry([
		...(options.music ? [createMusicScreenAdapter()] : []),
		...(options.image ? [createImageScreenAdapter()] : []),
		...(options.uiCompositions ? [createUiCompositionsAdapter(options.uiCompositions)] : []),
		...(options.objectRecognition
			? [createObjectRecognitionScreenAdapter()]
			: []),
		...(options.terminals ? [createTerminalsAdapter(options.terminals)] : []),
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
	);
	const recipes = createRecipePorts(
		history,
		() => agents,
		() => tools,
	);
	const adapter: ToolAdapter = {
		...reads,
		localInTransaction(db, r) {
			return r.tool.id === "recipe.find"
				? recipes.findInTransaction(db, r)
				: reads.localInTransaction!(db, r);
		},
		startInTransaction(db, r) {
			const raw = webToolArguments(
				r.tool.id,
				r.arguments as Record<string, unknown>,
				r.requestId,
			);
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
		...(options.reconcileThrottleMs === undefined
			? {}
			: { reconcileThrottleMs: options.reconcileThrottleMs }),
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
		tools,
		agents,
		history,
		/** Embed passages that have no vector in the provider's current space. */
		refreshVectors: vectors.refresh,
		/** Embed one request for retrieval; undefined when embedding is unavailable or slow. */
		embedQuery: vectors.embedQuery,
		postAnswer: undefined,
	};
}
