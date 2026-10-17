import type { ContextBlock } from "../../inference";
import type { Attachment } from "../../conversation/contracts";
import type { ChatMessage } from "./context";
import type { buildSystemPrompt } from "./system-prompt";

/** The persona the system part is written for: the agent's name, the user's name and the tone. */
export type PersonaSpec = Parameters<typeof buildSystemPrompt>[0];

/**
 * The host's rules that are part of the system part (S). Each says when it applies ("the block of this source is
 * present"), so the list is the same on every turn: the system part never changes between the calls of a
 * conversation, and what a turn adds is data only.
 */
export type HostRuleId =
	| "no_functions"
	| "context_sources"
	| "operation_action"
	| "operation_recognition"
	| "operation_delegation"
	| "operation_drawing"
	| "operation_image"
	| "operation_music"
	| "operation_command_question"
	| "research_result"
	| "research_world"
	| "research_document";

/** The rules of a conversation generation, in the order the system part writes them. */
export const CONVERSATION_HOST_RULES: readonly HostRuleId[] = [
	"no_functions",
	"context_sources",
	"operation_action",
	"operation_recognition",
	"operation_delegation",
	"operation_drawing",
	"operation_image",
	"operation_music",
	"operation_command_question",
	"research_result",
	"research_world",
	"research_document",
];

/**
 * One message of the conversation history as the ledger holds it: the native role and text, never wrapped.
 * `layer` is how memory classes the exchange it belongs to; `messageId` ties it to the ledger.
 */
export type HistoryTurn = {
	role: "user" | "assistant";
	content: string;
	attachments?: Attachment[];
	sourceMessageId?: string;
	messageId: string;
	layer: "keep" | "unprocessed";
	/** When the conversation accepted the message. */
	at: string;
};

/**
 * What a conversation generation shows the model, before any format is applied: the content of the context by
 * part, with no frame text and no layout. A format (`renderContext`) turns it into the message list.
 *
 * - `persona`, `hostRules`: the system part (S) is written from them.
 * - `stable`: reference data that changes rarely (P): long-term memory, the adopted goals.
 * - `history`: the verbatim exchanges (H), the kept ones first, then those no memory step has taken yet.
 * - `working`: the summary and the short-term notes (W).
 * - `volatile`: what holds for this call only (V): notices, recalled exchanges, the World names hint, the
 *   specialist records, the operation results, a research report.
 * - `input`: the user's input of this run (R).
 *
 * A failed research answer is not assembled this way: it keeps its own context (`researchResultContext`).
 */
export type ContextAssembly = {
	stage: "initial" | "selection" | "result";
	persona: PersonaSpec;
	hostRules: readonly HostRuleId[];
	stable: ContextBlock[];
	history: { turns: HistoryTurn[] };
	working: ContextBlock[];
	volatile: ContextBlock[];
	input: ChatMessage;
};
