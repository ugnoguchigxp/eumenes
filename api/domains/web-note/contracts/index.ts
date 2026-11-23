import type {
	ExecutionResult,
	ExecutionSource,
	ExecutionView,
	GoalExecutionSource,
	SupervisedExecutionSource,
	ToolchainExecutionPort,
} from "../../tool-runtime";
import type { Database } from "bun:sqlite";

/** What the research note task keeps of one run (the row's `data_json`). */
export type HostState = {
	source: ExecutionSource | GoalExecutionSource;
	request: string;
	toolchainRevisionId: string;
	bindingRevisionId: string;
	/** Fingerprint of the host-issued start operation for supervised research. */
	startDigest?: string;
	/** The package's profile and SKILL, with `{{today}}` still in them. */
	instructions: string;
	/** Present only for a source inspection. Once captured, the commit is immutable. */
	inspection?: { commit?: string };
	result: ExecutionResult | null;
};

export type InspectSource = {
	resolveCommit(signal: AbortSignal): Promise<string>;
	inspect(input: {
		commit: string;
		prompt: string;
		signal: AbortSignal;
	}): Promise<{ result: ExecutionResult; usage: WebNoteAttempt["usage"] }>;
};

/** How the notice of a finished run reaches the conversation. */
export type NoticeState = "none" | "pending" | "accepted" | "delivered";

/** One Codex turn with the research instructions: the host's seam (a fake in tests). */
export type WebNoteTurn = (input: {
	/** The research model (`policy.json`): fixed, whatever LLM the conversation is set to. */
	model: string;
	reasoning: "low" | "medium" | "high";
	webSearch: "disabled" | "cached" | "live";
	prompt: string;
	signal: AbortSignal;
}) => Promise<{
	text: string;
	searches: number;
	usage: {
		input: number;
		cachedInput: number;
		output: number;
		reasoning: number;
	} | null;
}>;

/** The finished turn as the inference ledger records it (a Codex SDK attempt). */
export type WebNoteAttempt = {
	subject: string;
	model: string | null;
	started: number;
	ended: number;
	status: "succeeded" | "failed";
	reason: string | null;
	usage: {
		input: number;
		cachedInput: number;
		output: number;
		reasoning: number;
	} | null;
};

export type SourcePort = Pick<
	ToolchainExecutionPort,
	| "validSourceInTransaction"
	| "deliverInTransaction"
	| "deliveryStateInTransaction"
	| "revokeDeliveryInTransaction"
> & {
	supervised?: {
		authorizeInTransaction(
			db: Database,
			input: {
				source: SupervisedExecutionSource;
				request: string;
				toolchainRevisionId: string;
				bindingRevisionId: string;
				action: "start" | "view" | "cancel" | "continue";
				workId?: string;
				operationId?: string;
			},
		): { deadline: number } | null;
		deliverInTransaction(
			db: Database,
			source: SupervisedExecutionSource,
			view: ExecutionView,
			eventId: string,
		): boolean;
	};
};

export type GoalWebNoteReceipt = {
	ownerWorkId: string;
	ownerRevision: number;
	status: ExecutionView["status"];
	result: ExecutionResult | null;
};
export type GoalWebNoteOwner = {
	authorityInTransaction(db: Database, source: GoalExecutionSource): boolean;
	observeInTransaction(
		db: Database,
		source: GoalExecutionSource,
		receipt: GoalWebNoteReceipt,
	): void;
};
