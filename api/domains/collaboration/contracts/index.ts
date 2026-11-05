import type { Database } from "bun:sqlite";

export type CollaborationKind = "pipeline" | "interact";
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
export type Ports = {
	/** The owning specialist's adopted explanation of this exact child's terminal result. */
	report?(db: Database, sessionId: string, childId: string): string | null;
	source(db: Database, runId: string): Source | null;
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
	): ChildView;
	forget(
		db: Database,
		kind: CollaborationKind,
		source: Source,
		workRef: string,
	): void;
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
			event: ChildView;
		},
	): boolean;
};
