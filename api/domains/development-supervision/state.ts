import type {
	ExecutionReference,
	ExecutionResponse,
	ExecutionResult,
	ExecutionView,
} from "../tool-runtime";
import type {
	ResearchKind,
	SupervisedGrant,
	SupervisionAuthority,
	SupervisionChildEvidence,
	SupervisionDesignBinding,
	SupervisionMode,
	SupervisionNote,
	SupervisionOutcome,
	SupervisionScope,
	SupervisionWorkspaceEvidence,
	SupervisionOwnedEdit,
	SupervisionWorkspace,
	SupervisionSource,
} from "./contracts";
import type { Proposal } from "./decisions";

export type WorkStatus = "waiting" | "running" | "held" | "finished";
export type Task = {
	id: string;
	revision: number;
	generation: number;
	proposal: Proposal;
	ceiling: SupervisionAuthority | null;
	dependsOn: string | null;
	designRevision: number | null;
	phase: "dispatch" | "child" | "evaluate" | "replan" | "finished";
	state: WorkStatus;
	reason: string;
	blockerRef?: string;
	result: ExecutionResult | null;
	outcome: SupervisionOutcome | null;
	grantRef: string | null;
	before: SupervisionWorkspaceEvidence | null;
	ownedEdit?: SupervisionOwnedEdit;
	readEvidence: SupervisionChildEvidence[];
	replanEvidence: string[];
	replanChangedInput: boolean;
	evidence: SupervisionChildEvidence[];
	jobId: string | null;
	dispatchFailed: boolean;
	verify?: Omit<Proposal, "title" | "after" | "verification">;
};
export type Plan = {
	title: string;
	analysis: string;
	proposals: Proposal[];
	mode: "review" | "execute";
	guideQuery?: string;
};
export type Parent = {
	id: string;
	generation: number;
	revision: number;
	source: SupervisionSource;
	goalScope?: SupervisionScope;
	/** Left on parents saved before the TODO ledger was retired: such a parent no longer has a current source. */
	confirmation?: { id: string; request: string; digest: string };
	request: string;
	workspace: SupervisionWorkspace;
	references: ExecutionReference[];
	profile: string;
	skills: string[];
	attemptMs: number;
	deadline: number;
	calls: number;
	childCalls: number;
	ceiling: SupervisionAuthority | null;
	limits: { calls: number; children: number; research: number };
	conversationSummary: ExecutionView["conversationSummary"];
	phase:
		| "authority"
		| "plan"
		| "research"
		| "design"
		| "waiting_design"
		| "active"
		| "held"
		| "finished";
	jobId: string | null;
	plan: Plan | null;
	pendingTaskId: string | null;
	designs: SupervisionDesignBinding[];
	designUris: Record<string, string>;
	research: Array<{
		kind: ResearchKind;
		grantRef: string;
		note: SupervisionNote | null;
		settled: boolean;
	}>;
	context: SupervisionNote[];
	tasks: Task[];
	result: ExecutionResult | null;
	stop: "cancelled" | "interrupted" | null;
	forgotten: boolean;
	question: ExecutionView["question"];
	goalQuestionReleased?: boolean;
	questionOp: string | null;
	notices: {
		id: string;
		active: boolean;
		delivered: boolean;
		kind: "question" | "progress" | "final";
	}[];
	controls: {
		mode: "amend";
		text: string;
		taskId: string | null;
		source?: ExecutionResponse;
	}[];
	observedAt: number;
	reason: string;
};
export type Grant = SupervisedGrant & {
	stopOperationId: string | null;
	revoked: boolean;
	released: boolean;
};
export type Question = {
	id: string;
	parentId: string;
	grantRef: string;
	workId: string;
	childQuestionId: string;
	executionId: string | null;
	prompt: string;
	inputSchema: Record<string, unknown>;
	absoluteDeadline: number;
	status: "queued" | "presented" | "answered" | "closed";
	presentedAt: number | null;
	expiresAt: number | null;
	presentOperationId: string | null;
	answer: {
		operationId: string;
		messageId: string;
		failReported: boolean;
	} | null;
};
export type ScopeFor<T extends SupervisionMode> = SupervisionScope & {
	mode: T;
};

export const executionEnded = (status: ExecutionView["status"]) =>
	status === "completed" ||
	status === "partial" ||
	status === "failed" ||
	status === "cancelled" ||
	status === "interrupted";

export const taskOutcome = (
	status: ExecutionView["status"],
): SupervisionOutcome => {
	switch (status) {
		case "completed":
			return "succeeded";
		case "partial":
			return "partial";
		case "cancelled":
			return "cancelled";
		case "interrupted":
			return "interrupted";
		default:
			return "failed";
	}
};
