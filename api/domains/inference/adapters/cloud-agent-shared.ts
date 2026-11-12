import Anthropic from "@anthropic-ai/sdk";
import { rm } from "node:fs/promises";
import type {
	NativeTool,
	NativeToolCall,
} from "../../../infrastructure/chat-stream";
import { getLogger } from "../../../infrastructure/logger";
import { systemContext } from "../../../infrastructure/system-context";
import type { AgentAuth, ConnectionKind } from "../../settings/contracts";
import type { Messages } from "../contracts";
import {
	normalizeHistory,
	splitMessages,
	type ContextSplit,
} from "./claude-session";

export type CloudAgentKind = Extract<
	ConnectionKind,
	"codex-sdk" | "claude-agent-sdk"
>;
/**
 * A Claude Agent SDK call that belongs to a session of the host's ledger. `main` resumes from the history the host
 * assembled (`context` says where `messages` splits); `subagent` keeps one session id per task and no history.
 */
export type AgentSessionCall = {
	id: string;
	role: "main" | "subagent";
	context?: ContextSplit;
	/** The SDK asked to delete the session: drops the ledger row. */
	drop(): Promise<void>;
};
export type CloudAgentCall = {
	onUsage?: (usage: import("./codex-usage").CodexUsage) => void;
	kind: CloudAgentKind;
	/** The saved connection and the attempt this call belongs to (log correlation only). */
	connectionId?: string;
	attemptId?: string;
	session?: AgentSessionCall;
	model: string;
	baseUrl: string;
	/** Null: Codex keeps its own login; a Claude Agent SDK call without a credential fails. */
	credential: string | null;
	/** Claude Agent SDK only: which credential `credential` is (an API key or a `claude setup-token` OAuth token). */
	auth?: AgentAuth;
	messages: Messages;
	tools?: NativeTool[];
	/** JSON Schema the final text must satisfy (control requests). */
	outputSchema?: Record<string, unknown>;
	reasoningEffort?: "low" | "medium" | "high";
	nativeWebSearch?: true;
	signal: AbortSignal;
	onDelta?: (text: string) => void;
};
export type CloudAgentResult = {
	reasoningTokens?: number | null;
	usageModel?: string | null;
	text: string;
	toolCalls?: NativeToolCall[];
	inputTokens?: number | null;
	outputTokens?: number | null;
	cacheReadTokens?: number | null;
	cacheCreationTokens?: number | null;
	/** Reported only on the API-key path; a subscription call has no per-call price. */
	costUsd?: number | null;
	/** The model's input context window as the CLI reported it (learned after a turn). */
	contextWindow?: number | null;
};
export type CloudAgents = {
	run(call: CloudAgentCall): Promise<CloudAgentResult>;
	/** Something was forgotten: whatever an agent kept of past calls is dropped. */
	forget?(): void;
	/** Stops what the agents keep running between calls. */
	close?(): Promise<void>;
};

const log = getLogger("inference");
const outputLimit = 262_144;
const code = /^[a-z][a-z0-9_]{0,100}$/;
export const fail = (reason: string) => new Error(`cloud_agent_${reason}`);

/**
 * Leading system messages become the instructions; the rest is one prompt. A multi-turn prompt is passed as JSON
 * so message text cannot forge turns. With a session context the history is split off first and the prompt is
 * this turn's input only.
 */
export function promptParts(messages: Messages, context?: ContextSplit) {
	const parts = splitMessages(messages, context, () =>
		fail("invalid_session_context"),
	);
	const { turns: history, pending } = normalizeHistory(parts.history);
	const turns = [...pending, ...parts.turn];
	const rendered = renderTurn(
		turns,
		parts.turn,
		turns.length === 1 && turns[0]!.role === "user"
			? null
			: context
				? "turn-context"
				: "conversation-context",
	);
	return {
		system:
			parts.instructions.join("\n\n") ||
			systemContext("inference.contexts.cloud-agents.default-system", {}),
		history,
		prompt: rendered.prompt,
		images: rendered.images,
		/** The messages past the instructions (no session context: all of them). */
		turn: parts.turn,
	};
}

/**
 * What a thread that already holds the front of a call is sent: the messages past that front, in the format of a
 * turn of a session (the earlier part is in the thread).
 */
export function appendParts(messages: Messages) {
	return renderTurn(messages, messages, "turn-context");
}

function renderTurn(
	turns: ReadonlyArray<{ role: string; content: string }>,
	imaged: Messages,
	preface: "turn-context" | "conversation-context" | null,
) {
	let prompt =
		preface === null
			? turns[0]!.content
			: systemContext(`inference.contexts.cloud-agents.${preface}`, {}) +
				"\n" +
				JSON.stringify(
					turns.map((turn) => {
						const { role, content } = turn;
						const message = turn as Partial<Messages[number]>;
						return {
							role,
							content,
							...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
							...(message.tool_call_id
								? { tool_call_id: message.tool_call_id }
								: {}),
						};
					}),
				);
	const images = imaged.flatMap((m) => m.images ?? []);
	if (images.length) {
		let next = 1;
		const references = imaged.flatMap((m, i) =>
			m.images?.length
				? [{ message: i + 1, images: m.images.map(() => next++) }]
				: [],
		);
		prompt += "\n\nAttached image references: " + JSON.stringify(references);
	}
	if (!prompt.trim() && !images.length) throw fail("empty_prompt");
	return { prompt, images };
}

export function checkedText(text: string) {
	if (Buffer.byteLength(text) > outputLimit) throw fail("output_limit");
	return text;
}

export const callId = () => `call_${crypto.randomUUID()}`;

/**
 * Removes a per-call directory and then releases its protection from the sweep. A removal that fails (the sweep
 * collects it later) is logged without the path and never turns the call's result into a failure.
 */
export async function removeRoot(root: string, untrack: () => void) {
	try {
		await rm(root, { recursive: true, force: true, maxRetries: 3 });
	} catch (error) {
		log.warn("inference.agent_dir_remove_failed", {
			reason: (error as NodeJS.ErrnoException | undefined)?.code ?? "unknown",
		});
	} finally {
		untrack();
	}
}

/** Conversation tool schemas are flat objects; each property converts on its own. */
export function safeAgentError(error: unknown) {
	if (error instanceof Error && code.test(error.message)) return error;
	if (error instanceof Anthropic.APIError && typeof error.status === "number")
		return new Error(`cloud_agent_http_${error.status}`);
	return fail("failed");
}

/** Agent SDKs as cloud LLM providers. Process environment comes from Config. */
