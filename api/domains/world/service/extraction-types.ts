import type { Database } from "bun:sqlite";
import type { SourceRef } from "eumenes-memory";
import {
	extractionLimits,
	type CanonicalHasher,
	type ScopeRef,
} from "eumenes-world-model";
import { z } from "zod";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import { type SourceAdapter } from "../contracts";
import type { ForegroundSignal } from "./foreground";
import type { WorldHostGate } from "./host-gate";
import { type MemoryPort } from "./lifecycle-memory";
import type { WorldService } from "./world-service";

/** The slice of the inference service extraction uses (the LARM-only control path). */
export type ExtractionInference = {
	captureMaintenanceControlInTransaction(
		db: Database,
		input: { subject: string; deadline: number; maxOutputTokens: number },
	): string;
	executeControl(
		requestId: string,
		messages: { role: "system" | "user" | "assistant"; content: string }[],
		signal: AbortSignal,
	): Promise<{
		requestId: string;
		attemptId: string;
		value: string | Uint8Array;
	}>;
	acceptInTransaction(
		db: Database,
		receipt: {
			requestId: string;
			attemptId: string;
			value: string | Uint8Array;
		},
	): boolean;
	rejectControlInTransaction(
		db: Database,
		receipt: {
			requestId: string;
			attemptId: string;
			value: string | Uint8Array;
		},
		code: string,
	): void;
	cancelRequestsInTransaction(db: Database, requestIds: string[]): void;
	/** Proves the request is Local-only. Required: without it extraction refuses to run. */
	snapshotFor?(
		db: Database,
		subject: string,
	): { routes: { llm: { mode: string; cloudAllowed: boolean } } } | null;
};

export const extractionPayloadSchema = z.object({
	principal: z.string().min(1).max(200),
	scopeKey: z.string().min(1).max(200),
	eventIds: z
		.array(z.string().min(1).max(200))
		.min(1)
		.max(extractionLimits.maxUtterances),
});
export type ExtractionPayload = z.infer<typeof extractionPayloadSchema>;

export type Receipt = {
	requestId: string;
	attemptId: string;
	value: string | Uint8Array;
};
export type Message = {
	role: "system" | "user" | "assistant";
	content: string;
};

export type PreparedEvent = {
	eventId: string;
	manifestId: string;
	ref: SourceRef;
};
export type PreparedExtraction = {
	scope: ScopeRef;
	jobId: string;
	windowId: string;
	events: PreparedEvent[];
	dependencies: SourceRef[];
	window: {
		utteranceId: string;
		source: SourceRef;
		origin: "user_report";
		rootEvidenceId: string;
	}[];
	entities: unknown[];
	requestId: string;
	messages: Message[];
	dependentIds: string[];
};
export type ExtractionOutput = { receipt: Receipt; text: string };

/** Structural copy of the queue's job claim, so this domain needs no queue import. */
export type JobClaim<P> = {
	jobId: string;
	scope: string;
	kind: string;
	payloadVersion: number;
	payload: P;
	subjectRef: string | null;
	owner: string;
	attempt: number;
	generation: number;
	maxAttempts: number;
	deadlineAtMs: number | null;
};
export type SettleOutcome<O> =
	| { type: "success"; result: O; resultRef?: string }
	| { type: "retry"; errorCode: string; availableAtMs: number }
	| { type: "failed"; errorCode: string }
	| { type: "expired" }
	| { type: "interrupted"; errorCode: string };

/** Structurally the queue's HandlerDefinition; the application passes it to registerHandler. */
export type ExtractionHandler = {
	kind: string;
	payloadVersions: readonly number[];
	schema: z.ZodType<ExtractionPayload>;
	recovery: "replay_safe";
	resourceKey: string;
	prepareInTransaction(
		tx: Database,
		claim: JobClaim<ExtractionPayload>,
	):
		| { status: "ready"; input: PreparedExtraction }
		| { status: "stale"; reason: string };
	execute(
		input: PreparedExtraction,
		context: {
			signal: AbortSignal;
			jobId: string;
			attempt: number;
			generation: number;
		},
	): Promise<ExtractionOutput>;
	classify(error: unknown): "retry" | "fail";
	settleInTransaction(
		tx: Database,
		claim: JobClaim<ExtractionPayload>,
		input: PreparedExtraction | null,
		outcome: SettleOutcome<ExtractionOutput>,
	): "applied" | "stale" | { status: "failed"; errorCode: string };
	cancelInTransaction(
		tx: Database,
		job: {
			jobId: string;
			subjectRef: string | null;
			payload: ExtractionPayload;
		},
		reason: string,
	): void;
};

/** The slice of the queue scheduling uses. */
export type ExtractionQueue = {
	enqueueInTransaction(
		tx: Database,
		input: {
			scope: string;
			kind: string;
			dedupeKey: string;
			payload: unknown;
			subjectRef?: string | null;
			lane: "interactive" | "background";
			resourceKey?: string | null;
			maxAttempts?: number;
		},
	): { job: { id: string }; fresh: boolean };
	getInTransaction(tx: Database, id: string): { state: string } | null;
};

export type ExtractionPoint =
	| "prepared"
	| "executed"
	| "settle_begin"
	| "event_settled";

export type ExtractionReport = {
	jobId: string;
	disposition: "adopted" | "output_rejected" | "not_adopted";
	/** Reason codes only: never content. */
	reasons: string[];
	events: number;
	accepted: number;
	held: number;
	rejected: number;
};

export type ExtractionOptions = {
	store: SqliteStore;
	world: WorldService;
	/** One adapter per source namespace (the scope check and the content reader). */
	sources: readonly SourceAdapter[];
	queue: ExtractionQueue;
	inference: ExtractionInference;
	/** Startup gate; while closed nothing is extracted. */
	gate?: WorldHostGate;
	/**
	 * Foreground priority (P4-03): while it is active no job is scheduled, no
	 * attempt is prepared, and a running model call is cancelled. Omitted:
	 * the foreground never preempts (only the queue's own lane order applies).
	 */
	foreground?: ForegroundSignal;
	purpose?: string;
	/** Entities World knows in the Scope (the package has no read API for them; default: none). */
	entities?: (db: Database, scope: ScopeRef) => readonly unknown[];
	clock?: () => number;
	id?: () => string;
	hasher?: CanonicalHasher;
	stageBudgetMs?: number;
	confirmMs?: number;
	/** Replace single Memory calls (tests); production uses the public API only. */
	memory?: Partial<MemoryPort>;
	interpretationVersion?: string;
	onReport?: (report: ExtractionReport) => void;
	/** Test seam: throw to simulate a crash at that point. */
	hook?: (point: ExtractionPoint, info: { jobId: string }) => void;
};
