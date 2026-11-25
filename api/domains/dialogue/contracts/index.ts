import type { Database } from "bun:sqlite";
export {
	agencyStatusSchema,
	agencyThoughtsSchema,
	type AgencyActivity,
	type AgencyThought,
} from "./agency-status";
import { z } from "zod";
import type { DeliveryEmotion } from "../../delivery";
import {
	addresseeSchema,
	guidanceLanguageSchema,
	runViewingSchema,
} from "./specialist";
import type { HttpErrorStatus } from "../../../infrastructure/http";
/** The longest utterance the user may send (typed, corrected or spoken), in characters. */
export const UTTERANCE_MAX_CHARS = 4000;
const submitFields = z.object({
	requestId: z.uuid(),
	conversationId: z.string().min(1).max(120),
	text: z.string().trim().max(UTTERANCE_MAX_CHARS),
	guidanceLanguage: guidanceLanguageSchema.optional(),
	presentation: z.enum(["conversation", "artifact"]).optional(),
	attachmentIds: z
		.array(z.uuid())
		.max(8)
		.refine((ids) => new Set(ids).size === ids.length)
		.optional(),
	/** The user's other files (shared files uploaded to `/api/conversations/:id/scratch`); never the model's input. */
	fileIds: z
		.array(z.uuid())
		.max(8)
		.refine((ids) => new Set(ids).size === ids.length)
		.optional(),
	utteranceId: z.string().min(1).max(120).optional(),
	/** The saved item on screen, as a host source issued it; re-checked against the issued choices. */
	viewing: runViewingSchema.optional(),
	/** Who the screen showed as listening; a different addressee now refuses the send (`addressee_changed`). */
	addressee: addresseeSchema.optional(),
	/** The screen's own toolchain: a form submit goes straight to it, never through the main agent's selection. */
	toolchainId: z
		.string()
		.regex(/^[a-z0-9][a-z0-9.-]{0,63}$/)
		.optional(),
});
const hasInput = (v: {
	text: string;
	attachmentIds?: string[];
	fileIds?: string[];
}) => !!(v.text || v.attachmentIds?.length || v.fileIds?.length);
/** A pinned toolchain is a screen's form submit: only an artifact presentation carries one. */
const pinnedOnScreen = (v: {
	toolchainId?: string;
	presentation?: string;
	attachmentIds?: string[];
	fileIds?: string[];
	utteranceId?: string;
}) =>
	!v.toolchainId ||
	(v.presentation === "artifact" &&
		!v.attachmentIds?.length &&
		!v.fileIds?.length &&
		v.utteranceId === undefined);
export const submitSchema = submitFields
	.refine(hasInput, "input_required")
	.refine(pinnedOnScreen, "toolchain_requires_artifact");
export type Submit = z.infer<typeof submitSchema>;
/** Public HTTP input: voice runs are created only by voice-dialogue, never by clients. */
export const publicSubmitSchema = submitFields
	.omit({ utteranceId: true })
	.strict()
	.refine(hasInput, "input_required")
	.refine(pinnedOnScreen, "toolchain_requires_artifact");
export type PublicSubmit = z.infer<typeof publicSubmitSchema>;
/** The latest utterance's corrected text, answered again (the prompt edit design, section 4.1). */
export const resubmitSchema = z
	.object({
		requestId: z.uuid(),
		text: z.string().trim().max(UTTERANCE_MAX_CHARS),
	})
	.strict();
export type Resubmit = z.infer<typeof resubmitSchema>;
export const runSchema = z.object({
	id: z.string(),
	agentTaskId: z.string().nullable().optional(),
	requestId: z.string(),
	conversationId: z.string(),
	utteranceId: z.string().nullable(),
	status: z.enum([
		"queued",
		"running",
		"completed",
		"failed",
		"cancelled",
		"interrupted",
	]),
	revision: z.number().int(),
	inputMessageId: z.string(),
	answerMessageId: z.string().nullable(),
	/** Adopted pre-delegation notice; separate from the final answer and conversation memory. */
	announcement: z.string().max(65_536).nullable().optional(),
	error: z.string().nullable(),
	jobId: z.string().nullable(),
	deadlineAt: z.string().nullable(),
	deadlineFixed: z.boolean().optional(),
	sourceKind: z.enum(["manual", "voice", "schedule", "notice"]),
	scheduleId: z.string().nullable(),
	occurrenceId: z.string().nullable(),
	/** The specialist session this run is a turn of; null for the main conversation's runs. */
	specialistSessionId: z.string().nullable(),
	/** The toolchain a screen's form submit named; the run skips the main agent's selection. */
	pinnedToolchainId: z.string().nullable().optional(),
	createdAt: z.string(),
	updatedAt: z.string(),
});
export type Run = z.infer<typeof runSchema>;
/**
 * A prompt of the system's (a scheduled prompt, or a notice such as a finished delegated task):
 * stored as a user message but never learned from, offered no toolchain, run in the background.
 */
export const isSystemPrompt = (kind: Run["sourceKind"]) =>
	kind === "schedule" || kind === "notice";
/** A notice the host asks the conversation to report on; its text is hidden from the chat. */
export const noticeSchema = z.object({
	requestId: z.string().min(1).max(200),
	conversationId: z.string().min(1).max(120),
	text: z.string().trim().min(1).max(8000),
});
export type Notice = z.infer<typeof noticeSchema>;
export const progressSchema = z.object({
	runId: z.string(),
	status: runSchema.shape.status,
	text: z.string().max(65_536),
	/** In-memory text of the current generation; absent/null means no provisional body. */
	provisional: z
		.object({
			generationId: z.string().min(1),
			sequence: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
		})
		.nullable()
		.optional(),
	announcement: z.string().max(65_536).nullable().optional(),
	/** Machine-readable end reason of a failed run (never body text). */
	error: z.string().nullable().optional(),
});
export type RunProgress = z.infer<typeof progressSchema>;
export const promptTargetSchema = z.object({
	conversationId: z.string().min(1).max(120),
	text: z.string().trim().min(1).max(8000),
	deadlineMs: z.number().int().min(10_000).max(600_000).optional(),
});
export type PromptTarget = z.infer<typeof promptTargetSchema>;

/**
 * The steward as dialogue sees it (wired by the application). Called in the transaction in which a run ends,
 * after the run's exchange was recorded in memory's ledger.
 */
export type StewardRunEnd = {
	runId: string;
	conversationId: string;
	state: "completed" | "failed" | "interrupted" | "cancelled";
};
/** A memory request the conversation agent committed (section 13): queued as pending at once. */
export type StewardRequest = {
	conversationId: string;
	kind: "forget" | "remember" | "correct" | "goal" | "withdraw";
	what: string;
	detail?: string;
	/** The user's message the request comes from (its context, and the evidence of a remember or a correct). */
	sourceRef: string;
	/** The same id twice is one request: the second returns the first. */
	requestId?: string;
};
export interface StewardPort {
	runEndedInTransaction(db: Database, input: StewardRunEnd): void;
	requestInTransaction(
		db: Database,
		input: StewardRequest,
	): { id: string; replay: boolean };
	/**
	 * A pending forget whose targets the memory excluded at once (the immediate stage): the request waits as
	 * "excluded" and the steward runs the closure delete. False when the request is not a pending forget.
	 */
	excludedInTransaction(
		db: Database,
		input: {
			id: string;
			conversationId: string;
			/** What the closure delete removes: the ids the immediate stage excluded. */
			exclusion: StewardExclusion;
		},
	): boolean;
	/**
	 * Keeps a correction, forget or suppression that names no short reference until the agency settles it (it
	 * survives a restart). A forget's `id` is the id of its inbox request.
	 */
	targetRequestInTransaction(
		db: Database,
		input: { id: string; request: MemoryTargetRequest },
	): void;
	/** A forget of the conversation is not yet settled (no target decided, or none excluded yet). */
	hasPendingForgetInTransaction(db: Database, conversationId: string): boolean;
	/**
	 * The requests of the conversation the agency could not settle, each once: the next generation tells the user
	 * nothing was changed. What it returns it does not return again.
	 */
	takeUnresolvedTargetsInTransaction(
		db: Database,
		conversationId: string,
	): ReadonlyArray<{ id: string; what: string }>;
}
/** The shape of the steward's `ForgetExclusion`. */
export type StewardExclusion = {
	itemIds: string[];
	messageIds: string[];
	claimIds: string[];
	entityIds: string[];
	goalIds: string[];
};

/**
 * A correction, forget or suppression that names no short reference (the user described the target in words): the
 * agency resolves the target after the run ends (the redesign, section 5.2) and applies it through the memory's
 * immediate operations. The conversation agent is told "resolving" at once.
 */
export type MemoryTargetRequest = {
	conversationId: string;
	/** The run that asked: the change the agency makes carries it as its `sourceRunId`. */
	runId: string;
	kind: "correct" | "forget" | "suppress";
	/** What the model wrote of the target, and the correct text of a correction. */
	what: string;
	detail?: string;
	/** The user's messages of the run (the request stands on them), newest last. */
	messageIds: readonly string[];
	/** The quote and record of a correction, as the model gave them. */
	quote?: string;
	memory?: {
		text: string;
		polarity?: "affirmed" | "negated";
		validFrom?: string;
		validUntil?: string;
	};
	/** The action's key: the steward request's id for a forget (the same key twice is one request). */
	requestId: string;
};
export interface MemoryTargetPort {
	/** Records the request in the caller's transaction; the agency resolves it once the run ends. */
	requestInTransaction(db: Database, input: MemoryTargetRequest): void;
}

/**
 * The World as dialogue sees it (wired by the application): only the names of the known targets this turn's
 * wording mentions, so the model can tell that World has something to look up. Dialogue never reads World's
 * content; that goes through the research sub-agent. With no port, or World unusable, no name is returned.
 */
export type WorldContextNamesInput = {
	conversationId: string;
	/** This turn's input, then the previous exchange: the wording known World targets are looked for in. */
	texts: readonly string[];
};
export interface WorldContextPort {
	/** Display names of the known targets the wording names (at most five), in the order they were found. */
	knownNamesInTransaction(
		db: Database,
		input: WorldContextNamesInput,
	): string[];
	/**
	 * World's records for these names in the conversation's Scope (the read tool `read_world`, spec
	 * conversation-read-tools-design 2026-10-31 §2.1); null while World cannot be read. Absent: the tool is not offered.
	 */
	recordsInTransaction?(
		db: Database,
		names: readonly string[],
	): WorldRecords | null;
}

/** What `read_world` reads: targets found by the names with the claims around them, and documents that name them. */
export type WorldRecords = {
	/** At most five targets, each with the claims around it (snapshot, depth 1; at most twenty in all). */
	entities: Array<{ name: string; claims: string[] }>;
	/** At most three collected documents whose text holds one of the names: title and opening. */
	documents: Array<{ title: string; opening: string }>;
};

/**
 * What the conversation agent (eumenes-agency, wired by the application) keeps of itself, for its context: its
 * current interests, intents and what it means to say, as reference lines (never instructions), and its
 * opportunity when work changes.
 */
export interface AgencyLayerPort {
	/**
	 * Work the user asks a task toolchain for, held by the agent as its own assignment, as a research is (spec
	 * toolchain-assignment-as-research-2026-11-25.md): accepted with the agent's item id, or refused (a duplicate
	 * names the item that does it already).
	 */
	assign?(input: {
		toolchainId: string;
		revisionId: string;
		title: string;
		request: string;
		references: import("../../tool-runtime").ExecutionReference[];
		source: import("./agency-always-on").AssignmentSource;
		details?: import("./agency-always-on").AssignmentDetails;
		/**
		 * A screen's form submit: its message is not words of the talk (an artifact), yet it is the user's own action
		 * on the screen, so the agent takes it as the user's request for this assignment only.
		 */
		userMessage?: { id: string; text: string };
	}):
		| { status: "accepted"; id: string }
		| { status: "refused"; code: string; id?: string };
	isCurrentInputInTransaction?(
		db: Database,
		input: { sources: readonly string[]; complete: boolean },
		/** Also respect this conversation's native forgotten references when rendering its context. */
		conversationId?: string,
	): boolean;
	inputForMessageInTransaction?(
		db: Database,
		messageId: string,
	): { sources: readonly string[]; complete: boolean } | null;
	/** All input dependencies of the rendered projection, separate from citations. */
	inputForContextInTransaction?(
		db: Database,
		conversationId: string,
	): { sources: readonly string[]; complete: boolean };
	/** Settled reference data, never system instructions. */
	stateForContextInTransaction?(
		db: Database,
		conversationId: string,
	): readonly string[];
	/**
	 * The goals in the agenda's slots, in slot order (`## State` shows them). A goal resting on a forgotten, excluded
	 * or suppressed source is not returned. `state` is the short Japanese word the user would use ("進行中").
	 */
	goalSlotsInTransaction?(
		db: Database,
	): ReadonlyArray<{ slot: number; text: string; state: string }>;
	/**
	 * A forget of a record named by its short reference excluded these records and messages (the immediate stage), in
	 * the transaction of the run that asked: what the agent holds of them (items, plans, notes, goals) is taken out now.
	 */
	memoryExcludedInTransaction?(
		db: Database,
		input: {
			conversationId: string;
			itemIds: readonly string[];
			messageIds: readonly string[];
		},
	): void;
	/**
	 * The user's messages the reply of this run took into one of its model calls while it was written (words sent
	 * meanwhile, eumenes-steer): they are answered by that reply and join the log with it, so no run answers them again.
	 */
	steeredInTransaction?(db: Database, runId: string): readonly string[];
	/** The agency serves this conversation's replies (it keeps their tool calls in the history). */
	servesRepliesInTransaction?(db: Database, conversationId: string): boolean;
	/**
	 * What the reply of this run was given by the agency (memory, notes, the agent's state), captured now: its sources
	 * join the run's input, so forgetting reaches the reply; `complete: false` means something it was given is gone and
	 * the reply is not adopted.
	 */
	replyInputInTransaction?(
		db: Database,
		runId: string,
	): { sources: readonly string[]; complete: boolean } | null;
}

/** A message of a conversation agent's reply, in the chat shape the model reads. */
export type AgentMessage = {
	role: "system" | "user" | "assistant" | "tool";
	content: string;
	tool_calls?: Array<{
		id: string;
		type: "function";
		function: { name: string; arguments: string };
	}>;
	tool_call_id?: string;
};
export type AgentToolDefinition = {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
};
export type AgentToolCall = { id: string; name: string; arguments: string };

/**
 * The conversation agent (eumenes-agency, wired by the application): it answers every generation, using the
 * host's tools in its reply when the conversation calls for them. The host supplies the model call and the tools.
 */
/** The agent's parts of the system message, by name and without headings; the host lays them out in its sections. */
export interface ConversationAgentSystem {
	/** The natural-conversation base (section Role). */
	base: string;
	/** The persona's interests as character traits (section Role); absent without interests. */
	persona?: string;
	/** The spoken reply style (section Speaking); absent for a reply that is not read aloud. */
	spokenReplyStyle?: string;
	/** The leading emoji rule (section Emotion); absent when the setting is off. */
	emotionRules?: string;
	/** The fact rules (section Facts) in place of the host's own, where the agent serves work they would deny. */
	facts?: string;
}

export interface ConversationAgentPort {
	/** The agent's parts of the system message; fixed by the settings, so the cached prefix holds. */
	system(): ConversationAgentSystem;
	/**
	 * The agent's reply to the user's words may look for a toolchain and hand work to it (its rules say how): the host
	 * offers it `find_toolchain` and `delegate` then (spec router-package-integration, 2026-11-12). Absent: it may not.
	 */
	handsWork?(): boolean;
	respond(input: {
		/** The run this reply answers for, when it answers the user's words (the agency steers its reply by them). */
		run?: {
			conversationId: string;
			runId: string;
			/** The user's messages this reply's prompt already holds. */
			messageIds: readonly string[];
		};
		messages: AgentMessage[];
		traceInput?: true;
		/** Only read tools may be offered or run, including tools supplied by the agent itself. */
		readOnly?: boolean;
		chat: {
			complete(
				request: { messages: AgentMessage[]; tools: AgentToolDefinition[] },
				onDelta: (text: string) => void,
				signal: AbortSignal,
			): Promise<{ text: string; toolCalls: AgentToolCall[] }>;
		};
		tools: {
			tools: readonly AgentToolDefinition[];
			call(
				call: AgentToolCall,
				signal: AbortSignal,
			): Promise<{ content: string; end?: boolean }>;
		};
		signal: AbortSignal;
		onDelta(text: string): void;
		/** The calls one reply may make in all, refused ones included; the next chat call offers no call. */
		maxToolCalls: number;
	}): Promise<{
		text: string;
		/** The feeling the reply is said with (voice tone and motion); absent when none was chosen. */
		emotion?: DeliveryEmotion;
		/** A tool handed the work over and ended the reply. */
		ended: boolean;
		/** Prepares user-visible output for a reply with no words. The write returns true when the output is published. */
		prepareSilentOutput?(): Promise<((db: Database) => boolean) | undefined>;
		/** The agency's own tool calls of the reply and what they answered: kept in the history of its replies. */
		calls?: ReadonlyArray<{ name: string; arguments: string; content: string }>;
	}>;
}

export * from "./specialist";

export { errorReportSchema } from "./error-report";
/** HTTP status of each code the specialist and interaction operations throw. */
export const errorStatus = {
	specialist_session_not_found: 404,
	session_ended: 409,
	session_expired: 409,
	session_closing: 409,
	session_not_suspended: 409,
	session_not_active: 409,
	target_not_found: 404,
	work_unsaved: 409,
	work_busy: 409,
	specialist_unavailable: 503,
	addressee_changed: 409,
	interaction_not_found: 404,
	interaction_closed: 409,
	interaction_expired: 410,
	question_stale: 409,
	version_invalidated: 409,
	invalid_answer: 422,
	interaction_body_too_large: 413,
	interaction_capacity: 429,
	toolchain_unavailable: 503,
} as const satisfies Record<string, HttpErrorStatus>;

export * from "./debug-diagnostics";
export { contextCaptureSchema, runContextSchema } from "./context-input";
export type {
	ContextCapture,
	ContextCaptureSummary,
	RunContext,
} from "./context-input";
