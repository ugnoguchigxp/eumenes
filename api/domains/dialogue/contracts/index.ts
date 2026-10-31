import type { Database } from "bun:sqlite";
import { z } from "zod";
import type { DeliveryEmotion } from "../../delivery";
import { addresseeSchema, runViewingSchema } from "./specialist";
import type { HttpErrorStatus } from "../../../infrastructure/http";
const submitFields = z.object({
	requestId: z.uuid(),
	conversationId: z.string().min(1).max(120),
	text: z.string().trim().max(8000),
	presentation: z.enum(["conversation", "artifact"]).optional(),
	attachmentIds: z
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
const hasInput = (v: { text: string; attachmentIds?: string[] }) =>
	!!(v.text || v.attachmentIds?.length);
/** A pinned toolchain is a screen's form submit: only an artifact presentation carries one. */
const pinnedOnScreen = (v: {
	toolchainId?: string;
	presentation?: string;
	attachmentIds?: string[];
	utteranceId?: string;
}) =>
	!v.toolchainId ||
	(v.presentation === "artifact" &&
		!v.attachmentIds?.length &&
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
	.object({ requestId: z.uuid(), text: z.string().trim().max(8000) })
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
	/** A TODO of the conversation finished or asks the user something: the agent's opportunity to say so. */
	workChangedInTransaction(db: Database, conversationId: string): void;
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
}

export interface ConversationAgentPort {
	/** The agent's parts of the system message; fixed by the settings, so the cached prefix holds. */
	system(): ConversationAgentSystem;
	respond(input: {
		messages: AgentMessage[];
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
	}>;
}

export * from "./command-interactions";
export * from "./specialist";

export { errorReportSchema } from "./error-report";
export * from "./todo-notices";
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
