import type { Database } from "bun:sqlite";
import type { DesignInput } from "eumenes-agency/agenda/runtime";
import type {
	ExecutionReference,
	ExecutionResult,
	ExecutionSource,
	ExecutionView,
	ToolchainExecutionPort,
	SupervisedExecutionSource,
} from "../tool-runtime";

export const adapterRef = "adapter:development-supervision@1";
export const availabilityRef = "availability:development-supervision@1";

export type SupervisedSource = SupervisedExecutionSource;

export type SupervisionAuthority = "design" | SupervisionMode;
export type SupervisionMode = "read" | "verify" | "edit";
export type SupervisionCheck = {
	executable: string;
	args: string[];
	cwd: string;
};
export type SupervisionWorkspace = {
	workspaceRef: string;
	targetRevision: string;
	rootPath?: string;
	checkExecutables?: readonly string[];
};
export type SupervisionScope = {
	workspaceRef: string;
	mode: SupervisionMode;
	targetRevision: string;
	deadline: number;
	baselineInputDigest?: string;
	readablePaths: string[];
	writablePaths: string[];
	checks: SupervisionCheck[];
};
export type SupervisionTarget = {
	toolchainRevisionId: string;
	bindingRevisionId: string;
};
export type ResearchKind = "web.note" | "inspect.source";
export type SupervisionStart = SupervisionTarget & {
	operationId: string;
	source: SupervisedSource;
	request: string;
	references: ExecutionReference[];
	deadline: number;
};
export type SupervisedAuthorityRequest = SupervisionTarget & {
	source: SupervisedSource;
	workId?: string;
	request: string;
	action:
		| "start"
		| "continue"
		| "inspect"
		| "view"
		| "stop"
		| "cancel"
		| "present"
		| "answer";
	operationId?: string;
	questionId?: string;
	parentQuestionId?: string;
	messageId?: string;
};
export type SupervisedGrant = SupervisionTarget & {
	source: SupervisedSource;
	operationId: string;
	kind: ResearchKind | "claude";
	workId: string | null;
	scope: SupervisionScope;
	design: { revision: number; documentId: string; digest: string } | null;
};
export type SupervisionChildEvidence = {
	ref: string;
	kind: "read" | "edit" | "check";
	executionId: string;
	targetRevision: string;
	inputDigest?: string;
	text: string;
	path?: string;
	passed?: boolean;
	check?: SupervisionCheck;
};
export type SupervisionChildObservation = {
	view: ExecutionView;
	executionId: string | null;
	questionExecutionId?: string | null;
	evidence: SupervisionChildEvidence[];
	releaseConfirmed: boolean;
	blocking?: { state: "waiting" | "held"; reason: string };
	answerDelivery?: {
		operationId: string;
		state: "pending" | "delivered" | "failed";
	};
};
export type SupervisionEvidence = {
	ref: string;
	id: string;
	digest: string;
} & (
	| {
			kind: "web";
			sources: readonly {
				sourceId: string;
				url: string;
				title: string;
				fetchedAt: string;
			}[];
	  }
	| {
			kind: "source";
			locations: readonly {
				path: string;
				symbol: string | null;
				commit: string;
				startLine: number;
				endLine: number;
				digest: string;
			}[];
	  }
	| { kind: "memory" | "world" | "goal"; revision: string }
	| { kind: "skill"; reason: string }
);
export type SupervisionNote = {
	evidence: SupervisionEvidence;
	title: string;
	text: string;
	at: number;
};
export type SupervisionDesignBinding = {
	parentId: string;
	conversationId: string;
	sourceRunId: string;
	generation: number;
	revision: number;
	documentId: string;
	digest: string;
	evidence: readonly SupervisionEvidence[];
};
export type SupervisionDesignPreparation =
	| {
			kind: "ready";
			title: string;
			markdown: string;
			digest: string;
			evidence: readonly SupervisionEvidence[];
	  }
	| { kind: "blocked"; reason: string };
export type SupervisionDesignView = {
	documentId: string;
	digest: string;
	title: string;
	markdown: string;
	uri: string;
};
export type SupervisionWorkspaceEvidence = {
	staleReadRefs?: string[];
	targetRevision: string;
	inputDigest: string;
	preserved: boolean;
	snapshotId?: string;
};
export type SupervisionHost = Pick<
	ToolchainExecutionPort,
	| "validSourceInTransaction"
	| "controlSourceInTransaction"
	| "validReferenceInTransaction"
	| "readReferenceInTransaction"
	| "deliverInTransaction"
> & {
	revokeInTransaction(db: Database, noticeId: string): void;
	confirmedRequestInTransaction?(
		db: Database,
		source: ExecutionSource,
		confirmationId: string,
		requestedText: string,
	): { request: string; digest: string } | null;
	ledgerInTransaction?(db: Database, view: ExecutionView): void;
	workspace: {
		inTransaction(
			db: Database,
			source: ExecutionSource,
		): SupervisionWorkspace | null;
		resolveScope?(scope: SupervisionScope): SupervisionScope | null;
		authorizeInTransaction(
			db: Database,
			input: {
				source: ExecutionSource;
				parentRequest: string;
				ceiling: SupervisionAuthority;
				scope: SupervisionScope;
				authorityQuote: string;
				design: SupervisionDesignView;
			},
		): boolean;
		inspectInTransaction(
			db: Database,
			scope: SupervisionScope,
			workId?: string,
		): { reason?: string; blockerRef?: string; released?: boolean };
		capture(
			scope: SupervisionScope,
			signal: AbortSignal,
			baseline?: SupervisionWorkspaceEvidence,
		): Promise<SupervisionWorkspaceEvidence>;
	};
	research: {
		contextInTransaction?(
			db: Database,
			source: ExecutionSource,
			refs: readonly ExecutionReference[],
		): SupervisionNote[];
		validEvidenceInTransaction(
			db: Database,
			source: ExecutionSource,
			evidence: SupervisionEvidence,
		): boolean;
		targetInTransaction(
			db: Database,
			kind: ResearchKind,
		): SupervisionTarget | null;
		startInTransaction(
			db: Database,
			kind: ResearchKind,
			input: SupervisionStart,
		): ExecutionView;
		viewInTransaction(
			db: Database,
			grant: SupervisedGrant,
		): ExecutionView | null;
		noteInTransaction(
			db: Database,
			grant: SupervisedGrant,
			view: ExecutionView,
		): SupervisionNote | null;
		cancelInTransaction(
			db: Database,
			grant: SupervisedGrant,
			operationId: string,
		): void;
		skillSmith?(
			query: string,
			source: ExecutionSource,
			signal: AbortSignal,
		): Promise<SupervisionNote[]>;
	};
	child: {
		targetInTransaction(db: Database): SupervisionTarget | null;
		startInTransaction(db: Database, input: SupervisionStart): ExecutionView;
		viewInTransaction(
			db: Database,
			source: SupervisedSource,
			workId: string,
		): SupervisionChildObservation | null;
		presentInTransaction(
			db: Database,
			source: SupervisedSource,
			workId: string,
			input: {
				operationId: string;
				questionId: string;
				parentQuestionId: string;
				presentedAt: number;
				expiresAt: number;
			},
		): void;
		answerInTransaction(
			db: Database,
			source: SupervisedSource,
			workId: string,
			input: {
				operationId: string;
				questionId: string;
				parentQuestionId: string;
				messageId: string;
				answer: string;
			},
		): void;
		cancelInTransaction(
			db: Database,
			source: SupervisedSource,
			workId: string,
			input: { operationId: string },
		): void;
	};
	design: {
		prepare(
			input: DesignInput,
			evidence: readonly SupervisionEvidence[],
			signal: AbortSignal,
		): Promise<SupervisionDesignPreparation>;
		startInTransaction(
			db: Database,
			binding: SupervisionDesignBinding,
			prepared: Extract<SupervisionDesignPreparation, { kind: "ready" }>,
		): void;
		readInTransaction(
			db: Database,
			binding: SupervisionDesignBinding,
		): SupervisionDesignView | null;
		stateInTransaction(
			db: Database,
			binding: SupervisionDesignBinding,
		): "pending" | "ready" | "unavailable";
		cancelInTransaction(
			db: Database,
			documentId: string,
			forget?: boolean,
		): void;
	};
};

export type SupervisionOutcome =
	"succeeded" | "partial" | "failed" | "cancelled" | "interrupted";
type SupervisionRow = {
	parentId: string;
	taskId: string;
	conversationId: string;
	workspaceRef: string;
	title: string;
	revision: number;
	parentRevision: number;
	designRevision: number | null;
	reason: string;
	blockerRef?: string;
	result: ExecutionResult | null;
	evidenceRefs: string[];
};
export type SupervisedRow = SupervisionRow &
	(
		| { state: "waiting"; column: "todo" }
		| { state: "running" | "held"; column: "running" }
		| { state: "finished"; column: "finished"; outcome: SupervisionOutcome }
	);
export type SupervisionBoardControl = {
	operationId: string;
	conversationId: string;
	parentId: string;
	taskId?: string;
	expectedRevision: number;
	action: "status" | "amend" | "cancel";
	request?: string;
};
