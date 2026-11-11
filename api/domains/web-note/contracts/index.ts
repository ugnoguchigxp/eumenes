import type {
	ExecutionResult,
	ExecutionSource,
	ToolchainExecutionPort,
} from "../../tool-runtime";

/** What the research note task keeps of one run (the row's `data_json`). */
export type HostState = {
	source: ExecutionSource;
	request: string;
	toolchainRevisionId: string;
	bindingRevisionId: string;
	/** The package's profile and SKILL, with `{{today}}` still in them. */
	instructions: string;
	result: ExecutionResult | null;
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
	model: string;
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
>;
