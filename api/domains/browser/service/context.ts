import type { Database } from "bun:sqlite";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import type { QueueService } from "../../queue";
import type {
	ApprovedItem,
	BrowserCompletion,
	CaptureStart,
	CaptureView,
	Observation,
	OperationOutcome,
	TabView,
	TaskStepInput,
	TaskStepOutcome,
} from "../contracts";
import type {
	BrowserDriver,
	CaptureFiles,
	HostResolver,
	ImageEncoder,
} from "../contracts/ports";

/** One driver call sequence at a time per connection: the MCP session acts on a single "current tab". */
export function createSerial() {
	let tail: Promise<unknown> = Promise.resolve();
	let pending = 0;
	return {
		get busy() {
			return pending > 0;
		},
		run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
			pending++;
			const run = tail.then(() => {
				signal?.throwIfAborted();
				return fn();
			});
			tail = run.then(
				() => undefined,
				() => undefined,
			);
			return run.finally(() => {
				pending--;
			});
		},
	};
}
export type Serial = ReturnType<typeof createSerial>;

/** What a task step may do, bound to its task: every call is checked against the task's lease, epoch and grants. */
export type TaskApi = {
	tabs(): Promise<TabView[]>;
	observe(tabRef: string): Promise<Observation>;
	operate(
		tabRef: string | undefined,
		action: unknown,
	): Promise<OperationOutcome>;
	/** `quote` is the passage of the request the value was taken from. */
	grantFromRequest(input: {
		value: string;
		quote: string;
		origin: string;
		purpose: string;
	}): Promise<{ inputValueRef: string }>;
	/** Approvals the user gave this task (through `continueFrom`/`approvePending`) that are not used yet. */
	approvals(): ApprovedItem[];
	capture(
		input: Omit<CaptureStart, "requestId"> & { requestId?: string },
	): Promise<CaptureView>;
	/** A capture this task started; it only runs while the task does, so the task waits for it. */
	captureStatus(captureId: string): CaptureView;
};

/**
 * The per-step hook of the model loop (S2). One call is one queue job: it reads, decides, acts through `api`
 * and returns the next serialized core state; the domain stores it and queues the next step or ends the task.
 */
export type TaskStepRunner = (
	input: TaskStepInput,
	context: { signal: AbortSignal; api: TaskApi },
) => Promise<TaskStepOutcome>;

export type Ctx = {
	store: SqliteStore;
	queue: QueueService;
	driver: BrowserDriver;
	encoder: ImageEncoder;
	files: CaptureFiles;
	now: () => number;
	/** Origins of the Eumenes web screen; the only private addresses a task may open. */
	webOrigins: readonly string[];
	announce: (db: Database, notice: BrowserCompletion) => void;
	/** DNS, for the destination check; called outside writer transactions only. */
	resolveHost: HostResolver;
	/** Recent answers of `resolveHost`, by host name (null: it did not resolve). */
	dnsCache: Map<string, { at: number; addresses: string[] | null }>;
	runTaskStep?: TaskStepRunner;
	leaseMs: number;
	renewMs: number;
	taskMs: number;
	captureMs: number;
	/** The serial section of a connection; dropped when it ends. */
	serialOf: (connectionId: string) => Serial;
	/** Aborts running work: `task:<id>`, `capture:<id>`, `op:<id>`. */
	inflight: Map<string, AbortController>;
};

/** Error codes travel as plain `Error.message` values of this grammar. */
export const codeOf = (e: unknown, fallback: string) =>
	e instanceof Error && /^[a-z][a-z0-9_]*$/.test(e.message)
		? e.message
		: fallback;
