import type { Database } from "bun:sqlite";
import { z } from "zod";
import type { Owner } from "../../capabilities/contracts";

/**
 * Typed domain adapters and the common execution envelope (spec §5.3–§6.4). The application
 * registers one adapter per domain (`adapter:timers@1`); the conversation command host and the
 * UI action ledger both execute through it, so adding a profile/SKILL/package/UI variant that
 * uses an existing adapter never edits a dispatcher.
 */

/** Where an operation comes from. The adapter never trusts an owner the client declares. */
export type AdapterOrigin =
	| {
			kind: "conversation";
			owner: Owner;
			runId: string;
			conversationId: string;
			messageId: string;
	  }
	| { kind: "ui"; scope: string; actionRequestId: string }
	/**
	 * A specialist-session turn (spec toolchain-specialist-dialogue 2026-10-17 §4). The host fixes
	 * the work; the adapter accepts the operation only while `runId` holds that work's turn.
	 */
	| {
			kind: "specialist";
			sessionId: string;
			runId: string;
			conversationId: string;
			workRef: string;
	  };

type ResultRef = {
	owner: string;
	kind: string;
	id: string;
	schemaRef: string;
	revision?: number;
	digest?: string;
};
export type ReceiptRef = { owner: string; operationId: string; digest: string };

export type AdapterResult = {
	/** The domain receipt (e.g. TimerReceipt), stored and owned by the domain. */
	receipt: unknown;
	receiptRef: ReceiptRef;
	resultRefs: ResultRef[];
	/** true when the domain replayed an earlier identical request. */
	replay: boolean;
	/** Short projection handed to the conversation answer (never the full receipt body). */
	answerContext?: unknown;
};

/** A field-level reason a UI input was not accepted; nothing is saved. */
export type FieldError = { field: string; message: string };
export type InputAdapter = (
	raw: Record<string, unknown>,
) => { ok: true; value: unknown } | { ok: false; errors: FieldError[] };

/** The domain's view of one specialist session's work (host data, never model text). */
type SessionWorkState = {
	workRef: string;
	/** The saved item this work edits; null while a new work was never saved. */
	savedRef: string | null;
	/** Changes not yet saved by the user. */
	dirty: boolean;
	/** A specialist turn (queued or running) holds the work; undo/redo/save are refused. */
	busy: boolean;
	/** Draft revision; advances on every accepted change, undo, redo and save. */
	revision: number;
	/** Short label for notices and the conversation's work record (e.g. the AI-chosen title). */
	label: string;
	/** The current work handed to the specialist model as input data (bounded, no secrets). */
	current: unknown;
};

/**
 * The work a domain keeps for a specialist session (spec §4.5, §5). Dialogue owns the session,
 * its expiry and the conversation's addressee; the domain owns the draft and its history. Every
 * call runs inside the caller's writer transaction and is idempotent where noted.
 */
export interface SessionWorkAdapter {
	/**
	 * Start a work for a new session: empty when `targetRef` is null, otherwise from that saved
	 * item (a ref this adapter issued through `choicesInTransaction`). Throws `target_not_found`.
	 */
	openInTransaction(
		tx: Database,
		input: { sessionId: string; targetRef: string | null },
	): SessionWorkState;
	/** The work's current state, or null when it was ended. */
	stateInTransaction(tx: Database, workRef: string): SessionWorkState | null;
	/**
	 * Whether `targetRef` names a saved item a session may start from now (the same set
	 * `choicesInTransaction` draws from, without its 20-item cut).
	 */
	hasTargetInTransaction(tx: Database, targetRef: string): boolean;
	/** A specialist turn takes the work (from intake, so queued counts). Throws `work_busy`. */
	beginTurnInTransaction(tx: Database, workRef: string, runId: string): void;
	/**
	 * Release the turn and invalidate anything it still had in flight. No-op unless `runId`
	 * holds the work, so late or repeated calls are harmless.
	 */
	endTurnInTransaction(tx: Database, workRef: string, runId: string): void;
	/**
	 * End the work. `discard` drops the draft and its undo history (saved items stay);
	 * `close` requires no unsaved change (throws `work_unsaved`). Idempotent on an ended work.
	 */
	endInTransaction(
		tx: Database,
		workRef: string,
		mode: "discard" | "close",
	): void;
}

/** The outcome of an instant operation: the answer sentence, or a safe code for why there is none. */
export type InstantResult =
	| { ok: true; answer: string }
	| { ok: false; code: string };

/**
 * What an adapter offers an instant binding (spec weather-instant-toolchain-design 2026-10-18):
 * the first round of the conversation calls the toolchain's function with arguments, and the
 * sentence `run` returns is the answer, with no sub-agent and no second round. It runs outside
 * any transaction, so it may use the network.
 */
export interface InstantAdapter {
	/** Answer one validated call. Never throws for a failure of the service it asks. */
	run(
		operationName: string,
		input: unknown,
		signal: AbortSignal,
	): Promise<InstantResult>;
}

export interface DomainAdapter {
	/** `adapter:<owner>@<n>` */
	readonly ref: string;
	describe(): {
		owner: string;
		/** Operation name → its input schema ref and whether it changes state. */
		operations: ReadonlyMap<
			string,
			{ inputSchemaRef: string; effect: "read" | "write" }
		>;
		/** Registered read queries (`query:timers.current@1`) for OpenUI sources. */
		queries: ReadonlySet<string>;
		inputAdapters: ReadonlyMap<string, InputAdapter>;
		projections: ReadonlySet<string>;
		availability: string;
		/**
		 * Documents this adapter owns whose fields bundles may register (see documentFieldV1),
		 * describing what a fixed path names in the document's schema.
		 */
		documents?: ReadonlyMap<
			string,
			import("../../capabilities/contracts").DocumentDescription
		>;
		/** Field visibility conditions implemented by this adapter's Web counterpart. */
		conditions?: ReadonlySet<string>;
		/** Structural draft operations this adapter applies inside its document's apply. */
		structures?: ReadonlyMap<string, { inputSchemaRef: string }>;
		/** The adapter answers instant bindings (it has `instant`). */
		instant?: boolean;
	};
	/** The adapter's domain is configured and usable on this host now. */
	availableInTransaction(tx: Database): boolean;
	/** Targets the command sub-agent may name (host data, no model-generated ids). */
	snapshotInTransaction(tx: Database): unknown;
	/**
	 * Execute one validated operation inside the caller's writer transaction, through the
	 * domain's existing public transaction operation. Throws a safe error code on rejection.
	 */
	invokeInTransaction(
		tx: Database,
		request: {
			operationName: string;
			input: unknown;
			requestId: string;
			issuedAt: string;
			origin: AdapterOrigin;
		},
	): AdapterResult;
	/** The saved result of an earlier operation by its domain operation id, or null. */
	readInTransaction(tx: Database, operationId: string): AdapterResult | null;
	/**
	 * Read one registered query for an OpenUI source; null when the target does not exist.
	 * `params` were validated against the source binding's `paramsSchemaRef` (absent otherwise).
	 */
	sourceInTransaction(
		tx: Database,
		query: string,
		targetRef: string | undefined,
		params?: unknown,
	): { revision: number; data: unknown } | null;
	/** Convert a source and its current revision to the operation input fields it implies. */
	targetInput(
		query: string,
		targetRef: string,
		revision: number,
	): Record<string, unknown>;
	/**
	 * Host-issued choices for a question schema ref (e.g. the timers an answer may name), at most
	 * 20. Empty or absent: the schema has no choices on this host now.
	 */
	choicesInTransaction?(
		tx: Database,
		inputSchemaRef: string,
	): Array<{ ref: string; label: string }>;
	/** Called after the writer transaction commits (wake schedulers, publish changes). */
	afterCommit?(): void;
	/** Present when a session binding may use this adapter (spec §4.1). */
	session?: SessionWorkAdapter;
	/** Present when an instant binding may use this adapter. */
	instant?: InstantAdapter;
}

export interface AdapterRegistry {
	get(ref: string): DomainAdapter | undefined;
	all(): DomainAdapter[];
}

export function createAdapterRegistry(
	adapters: DomainAdapter[],
): AdapterRegistry {
	const map = new Map(adapters.map((a) => [a.ref, a] as const));
	if (map.size !== adapters.length) throw new Error("duplicate_adapter");
	return { get: (ref) => map.get(ref), all: () => [...map.values()] };
}

/** The common envelope around a domain receipt. It never replaces the receipt. */
type ExecutionOutcome =
	| "completed"
	| "needs_input"
	| "failed"
	| "cancelled"
	| "expired"
	| "indeterminate";
export type ExecutionResultV1 = {
	version: 1;
	executionId: string;
	interactionId?: string;
	chainRevisionId?: string;
	packageRevisionId?: string;
	bindingRevisionId?: string;
	artifactRevisionId: string;
	outcome: ExecutionOutcome;
	receiptRef?: ReceiptRef;
	resultRefs: ResultRef[];
	artifactRefs: Array<{
		artifactRevisionId: string;
		sourceRefs: Array<{ source: string; targetRef?: string }>;
	}>;
	inputRequest?: {
		questionId: string;
		prompt: string;
		inputSchemaRef: string;
		revision: number;
		expiresAt: string;
	};
	error?: { code: string; retry: "never" | "reconcile" | "user_resubmit" };
	/** The domain receipt for the UI to project into its snapshot (local adapters only). */
	receipt?: unknown;
};

const isoOffset = z.iso.datetime({ offset: true });
/**
 * A UI action sent to `POST /api/toolchain-actions` (§6.2). eventId doubles as the domain
 * requestId; both times are fixed at creation and never refreshed on resend.
 */
export const toolchainActionEventV1 = z
	.strictObject({
		version: z.literal(1),
		eventId: z.uuid(),
		eventCreatedAt: isoOffset,
		eventExpiresAt: isoOffset,
		/** The tab/instance id of the artifact on the Web (opaque, for the client's own use). */
		artifactId: z.string().regex(/^[A-Za-z0-9:_-]{1,80}$/),
		artifactRevisionId: z
			.string()
			.regex(/^artifact:[a-z][a-z0-9._-]{0,100}@[1-9][0-9]*$/),
		source: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
		sourceRevision: z.number().int().min(0),
		/** Host-issued target of the source (e.g. a timer id); never a scope. */
		targetRef: z
			.string()
			.regex(/^[A-Za-z0-9-]{1,64}$/)
			.optional(),
		actionId: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
		/** The host scope reference the artifact was issued under (from GET artifact). */
		scopeRef: z.string().regex(/^[A-Za-z0-9:_-]{1,80}$/),
		input: z.unknown(),
	})
	.refine(
		(e) => new TextEncoder().encode(JSON.stringify(e)).length <= 16_384,
		"payload_too_large",
	);
export type ToolchainActionEventV1 = z.infer<typeof toolchainActionEventV1>;

export type ActionRequestStatus =
	| "accepted"
	| "rejected"
	| "pending"
	| "indeterminate";
/** The stored acceptance of one UI action and its settled result. */
export type ActionRequestView = {
	eventId: string;
	status: ActionRequestStatus;
	/** Safe error code for rejected/indeterminate; field errors for invalid input. */
	errorCode?: string;
	fieldErrors?: FieldError[];
	result?: ExecutionResultV1;
	createdAt: string;
	settledAt?: string;
};
