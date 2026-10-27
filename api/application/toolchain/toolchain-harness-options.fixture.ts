import type { ComputePort } from "../../domains/compute";
import type { DrawingConnection } from "../../domains/excalidraw";
import type { LarmPlayground, LarmPort } from "../../domains/larm";
import type { createSettings } from "../../domains/settings";
import type { AcquisitionPort } from "../../domains/web-research";
import type { Step } from "./conversation-script.fixture";

/** The knobs of the toolchain harness (`harness` in toolchain.fixture.ts). */
export type HarnessOptions = {
	everyday?: boolean;
	/** Task pipelines run on the parent execution, without the suspended task bundle. */
	pipelines?: boolean;
	/** A pipeline's extract step: the value the model gives for the step's text. */
	extract?: (
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
	embed?: import("./toolchain-vectors").Embed;
	musicGateway?: () => LarmPlayground;
	imageGateway?: () => LarmPlayground;
	uiCompositions?: boolean;
	routeTool?: string;
	docling?: import("../../domains/docling").DoclingService;
	browser?: (
		store: import("../../infrastructure/sqlite").SqliteStore,
		queue: import("../../domains/queue").QueueService,
		capabilities: () => import("../../domains/capabilities").Capabilities,
	) => Pick<
		import("../browser/browser-composition").BrowserAssembly,
		"service" | "effects" | "requests"
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
	announcement?: string;
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
