import type { ComputePort } from "../../domains/compute";
import type { DrawingConnection } from "../../domains/excalidraw";
import type { LarmPlayground, LarmPort } from "../../domains/larm";
import type { createSettings } from "../../domains/settings";
import type { AcquisitionPort } from "../../domains/web-research";
import type { Step } from "./conversation-script.fixture";

/** The knobs of the toolchain harness (`harness` in toolchain.fixture.ts). */
export type HarnessOptions = {
	webResearch?: boolean;
	/** Keep the Web search withdrawn from selection as production seeds it (the fixtures otherwise publish its earlier revision). */
	withdrawnWebSearch?: true;
	/** Compose the real resource registry for autonomous output delivery. */
	resources?: boolean;
	/** Fixed Pursuit control output; enables the registered research owner's lifecycle. */
	pursuit?: (
		schema: Record<string, unknown>,
		messages: import("../../domains/inference/contracts").Messages,
	) => unknown;
	/** The research note task (Codex's own web search) with a scripted turn and a ledger record. */
	webNote?: Pick<
		import("../../domains/web-note").WebNoteDeps,
		"turn" | "record"
	>;
	/** A real memory service (its journal in the harness directory): what the conversation's `## Memory` shows. */
	memory?: boolean;
	everyday?: boolean;
	/** Task pipelines run on the parent execution, without the suspended task bundle. */
	pipelines?: boolean;
	schedules?: boolean;
	workflowRuntime?: (
		agents: import("../../domains/agent-runtime").AgentRuntime,
	) => Pick<
		import("./task-execution-port").TaskExecutionHost,
		"workflowAuthority" | "workflowSteps"
	>;
	/** A pipeline composer response, scripted independently from the child operations. */
	compose?: (
		messages: import("../../domains/inference/contracts").Messages,
	) => unknown;
	/** Script the package's structural judgment independently from planning and command execution. */
	structure?: (
		messages: import("../../domains/inference/contracts").Messages,
	) => unknown;
	computePort?: ComputePort;
	dots?: boolean;
	discoveryTarget?: (query: string) => string;
	acquisition?: AcquisitionPort;
	taskStep?: (
		tools: import("../../infrastructure/chat-stream").NativeTool[],
		messages: import("../../domains/inference/contracts").Messages,
	) => { name: string; arguments: Record<string, unknown> };
	/** The completion check of a delegated result; without it every request is achieved by its first step. */
	completion?: (
		tools: import("../../infrastructure/chat-stream").NativeTool[],
		messages: import("../../domains/inference/contracts").Messages,
	) => { name: string; arguments: Record<string, unknown> };
	model?: LarmPort;
	/** Keep the host's real tool lookup and conversation decision for a live acceptance run. */
	liveRouting?: boolean;
	/** Cloud transport seams for end-to-end attachment verification, with no external calls. */
	inferenceOptions?: Parameters<
		typeof import("../../domains/inference").createInference
	>[2];
	/** Use the real guidance adapter with this fixture cloud resource. */
	knowledgeSelectionResourceId?: string;
	knowledgeSource?: NonNullable<
		Parameters<
			typeof import("../knowledge/service").createKnowledge
		>[0]["source"]
	>;
	knowledgeBuild?: (
		messages: import("../../domains/inference/contracts").Messages,
		options: Parameters<LarmPort["answer"]>[2],
	) => unknown;
	/** Script only the collaborative specialist, retaining the real parent/command fixture. */
	specialist?: (
		messages: import("../../domains/inference/contracts").Messages,
		signal: AbortSignal | undefined,
		options: Parameters<LarmPort["answer"]>[2],
	) => unknown | Promise<unknown>;
	embed?: import("./toolchain-vectors").Embed;
	musicGateway?: () => LarmPlayground;
	imageGateway?: () => LarmPlayground;
	appDevelopment?: {
		git: ReturnType<
			typeof import("../../domains/git-observation").createGitObservation
		>;
		destination?: () => { namespace: string; path: string } | null;
		control?: (
			messages: import("../../domains/inference/contracts").Messages,
			signal: AbortSignal,
			options: Parameters<LarmPort["answer"]>[2],
		) => string | Promise<string>;
	};
	uiCompositions?: boolean;
	scratch?: import("../../domains/scratch").ScratchStore;
	markdown?: import("../../domains/markdown").ArchivePort;
	routeTool?: string;
	docling?: import("../../domains/docling").DoclingService;
	browser?: (
		store: import("../../infrastructure/sqlite").SqliteStore,
		queue: import("../../domains/queue").QueueService,
		capabilities: () => import("../../domains/capabilities").Capabilities,
	) => Pick<
		import("../browser/browser-composition").BrowserAssembly,
		"service" | "effects" | "requests"
	> &
		Partial<
			Pick<import("../browser/browser-composition").BrowserAssembly, "interact">
		>;
	review?: (
		input: import("llm-fetch").GuardReviewInput,
	) => Promise<import("llm-fetch").GuardReviewDecision>;
	command?: (
		messages: import("../../domains/inference/contracts").Messages,
	) => string;
	drawingConnection?: () => DrawingConnection;
	drawingFetch?: typeof fetch;
	drawingIdleMs?: number;
	recognitionFetcher?: typeof fetch;
	ocrFetcher?: typeof fetch;
	visual?: () => import("../../domains/larm").PerceptionPort;
	/** PTY sessions for the Claude Code toolchain (a fake spawn in tests), over the harness store. */
	shell?: (
		store: import("../../infrastructure/sqlite").SqliteStore,
	) => import("../../domains/shell").ShellService;
	terminals?: (
		store: import("../../infrastructure/sqlite").SqliteStore,
	) => import("../../domains/terminals").TerminalsService;
	/** The task board over `terminals` (its runs are handed to those PTYs). */
	kanban?: boolean;
	kanbanComposition?: (
		store: import("../../infrastructure/sqlite").SqliteStore,
		settings: Awaited<ReturnType<typeof createSettings>>,
		capabilities: () => import("../../domains/capabilities").Capabilities,
	) => ReturnType<typeof import("../work/kanban-sdk-host").createKanbanSdkHost>;
	settingsEnv?: Record<string, string | undefined>;
	gate?: Promise<void>;
	/** Holds the operation sub-agent's call (after its context is recorded) until released. */
	commandGate?: Promise<void>;
	commandGateQuestion?: string;
	badJson?: boolean;
	workerOutput?: string;
	workerReportOutput?: string;
	voiceText?: string;
	parentAnswer?: string;
	speechFailure?: boolean;
	badQuote?: boolean;
	badQuoteOnce?: boolean;
	excerptEvidence?: boolean;
	/** Synthetic replay overrides only; never records live provider content. */
	control?: (
		messages: import("../../domains/inference/contracts").Messages,
	) => string | Promise<string> | undefined;
	acquire?: AcquisitionPort["execute"];
	acquisitionTimeoutMs?: number;
	parent?: (
		messages: import("../../domains/inference/contracts").Messages,
	) => string | Promise<string>;
	history?: boolean;
	incompleteWeatherFirstRead?: boolean;
	badToolArgs?: boolean;
	badExecutionRefOnce?: boolean;
	clarify?: boolean;
	timers?: boolean;
	timerNow?: () => number;
	/** Model returns a timer command with a forbidden extra field. */
	timerExtra?: boolean;
	queueLimits?: { total: number; background: number; scope: number };
	/** The forecast service the weather toolchain reads (absent: no weather toolchain). */
	weather?: { fetch: typeof fetch };
	/** The services the stock toolchain reads (absent: no stock toolchain). */
	stock?: { fetch: typeof fetch };
	/**
	 * The step a user's utterance's model call makes, written by the test from the tools offered and the
	 * messages so far (see conversation-script.fixture.ts), or undefined to leave the call to the default model.
	 */
	firstRound?: (
		tools: ReadonlyArray<{
			function: { name: string; parameters?: Record<string, unknown> };
		}>,
		question: string,
		messages: import("../../domains/inference/contracts").Messages,
	) => Step | undefined;
};
