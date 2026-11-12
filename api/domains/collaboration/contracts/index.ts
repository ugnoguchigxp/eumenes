import type { Database } from "bun:sqlite";

export type CollaborationKind = "pipeline" | "interact" | "brave" | "task";
export type WorkKind = CollaborationKind | "schedule";
/** Resolved from a real dialogue input, never from a model's claimed approval. */
export type Source = {
	conversationId: string;
	messageId: string;
	runId: string;
	request: string;
	digest: string;
	specialistSessionId?: string;
	specialistEpoch?: number;
};
export type SourceRef = Omit<Source, "request">;
export type Issue = { path: string; rule: string };
export type RejectedDraft = {
	title: string;
	text: string;
	issues: Issue[];
	fixes: string[];
	createdAt: string;
};
export type Check =
	{ ok: true; value: unknown } | { ok: false; issues: Issue[] };
export type ChildView = {
	id: string;
	status:
		| "running"
		| "waiting_user"
		| "completed"
		| "partial"
		| "failed"
		| "cancelled"
		| "indeterminate";
	revision: number;
	summary?: string;
	excerpt?: string;
	inputSchema?: Record<string, unknown>;
	question?: {
		id: string;
		prompt: string;
		approval: boolean;
		revision: number;
		generation?: number;
		expiresAt?: number;
	};
};
export type Authority = {
	conversationId: string;
	epoch: number;
	active: boolean;
};
export type ReviewConditions =
	| { state: "none" | "unavailable" }
	| {
			state: "available";
			entries: {
				id: string;
				text: string;
				sources: { id: string; version: string; active: boolean }[];
			}[];
	  };
export type ReviewInput = {
	id: string;
	workRef: string;
	revision: number;
	document: unknown;
	source: Source;
	request: string;
	conditions: ReviewConditions;
};
export type ReviewOutcome = {
	status: "completed" | "incomplete" | "failed" | "cancelled";
	summary: string;
	result?: unknown;
};
export type ReviewPort = {
	conditions(db: Database, sessionId: string): ReviewConditions;
	evaluate(
		input: ReviewInput,
		deadline: number,
		signal: AbortSignal,
		current: (db: Database) => boolean,
	): Promise<ReviewOutcome>;
};
export type Ports = {
	/** The owning specialist's adopted explanation of this exact child's terminal result. */
	report?(db: Database, sessionId: string, childId: string): string | null;
	review?: ReviewPort;
	continuation?(db: Database, source: Source, id: string): ChildView | null;
	amend?(
		db: Database,
		response: Source,
		childId: string,
		revision: number,
		request: string,
	): ChildView;
	source(db: Database, runId: string): Source | null;
	/** Recheck a contribution already registered to the work, even if the utterance was handed over. */
	contributingSource?(
		db: Database,
		input: Pick<Source, "runId" | "messageId" | "conversationId" | "digest">,
	): boolean;
	authority(db: Database, sessionId: string): Authority | null;
	available(db: Database, kind: CollaborationKind): boolean;
	context(db: Database, kind: CollaborationKind, source: Source): unknown;
	check(
		db: Database,
		kind: CollaborationKind,
		value: unknown,
		source: Source,
	): Check;
	start(
		db: Database,
		kind: CollaborationKind,
		input: {
			workRef: string;
			requestId: string;
			source: Source;
			response: Source;
			history: Source[];
			value: unknown;
			previousChildId?: string;
		},
	): ChildView;
	view(
		db: Database,
		kind: CollaborationKind,
		source: Source,
		childId: string,
	): ChildView | null;
	answer(
		db: Database,
		kind: CollaborationKind,
		source: Source,
		response: Source,
		child: ChildView,
		input: unknown,
		history: Source[],
		workRef: string,
	): ChildView;
	forget(db: Database, kind: WorkKind, source: Source, workRef: string): void;
	cancel(
		db: Database,
		kind: CollaborationKind,
		source: Source,
		childId: string,
	): void;
	notify(
		db: Database,
		input: {
			sessionId: string;
			epoch: number;
			sourceRunId: string;
			eventId: string;
			event:
				| ChildView
				| (ReviewOutcome & { kind: "review"; id: string; revision: number });
		},
	): boolean;
};
