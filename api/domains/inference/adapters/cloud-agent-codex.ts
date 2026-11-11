import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NativeTool } from "../../../infrastructure/chat-stream";
import { systemContext } from "../../../infrastructure/system-context";
import { AGENT_ROOT_PREFIX, trackClaudeRoot } from "./claude-session";
import { callId } from "./cloud-agent-shared";
import { runCodexTurn } from "./codex-app-server";
import { type CodexRuntime } from "./codex-sdk";

import {
	checkedText,
	fail,
	promptParts,
	removeRoot,
	type CloudAgentCall,
	type CloudAgentResult,
} from "./cloud-agent-shared";
/** Codex has no host-defined functions: a strict output schema chooses reply or call. */
function codexChoiceSchema(tools: NativeTool[]) {
	return {
		type: "object",
		additionalProperties: false,
		required: ["reply", "tool"],
		properties: {
			reply: { type: ["string", "null"] },
			tool: {
				anyOf: [
					{ type: "null" },
					{
						type: "object",
						additionalProperties: false,
						required: ["name", "arguments"],
						properties: {
							name: { type: "string", enum: tools.map((t) => t.function.name) },
							arguments: {
								type: "string",
								description: "The function arguments as one JSON object.",
							},
						},
					},
				],
			},
		},
	};
}
function codexFunctions(tools: NativeTool[]) {
	return (
		systemContext("inference.contexts.cloud-agents.function-selection", {}) +
		"\n" +
		JSON.stringify(tools.map((t) => t.function))
	);
}
function codexChoice(final: string, tools: NativeTool[]): CloudAgentResult {
	let value: {
		reply?: unknown;
		tool?: { name?: unknown; arguments?: unknown };
	};
	try {
		value = JSON.parse(final);
	} catch {
		throw fail("invalid_output");
	}
	const call = value?.tool;
	if (call && typeof call === "object") {
		const name = call.name;
		if (
			typeof name !== "string" ||
			!tools.some((t) => t.function.name === name) ||
			typeof call.arguments !== "string"
		)
			throw fail("invalid_tool_call");
		let args: unknown;
		try {
			args = JSON.parse(call.arguments);
		} catch {
			throw fail("invalid_tool_call");
		}
		if (!args || typeof args !== "object" || Array.isArray(args))
			throw fail("invalid_tool_call");
		return {
			text: "",
			toolCalls: [{ id: callId(), name, arguments: JSON.stringify(args) }],
		};
	}
	if (typeof value?.reply !== "string" || !value.reply.trim())
		throw fail("empty_output");
	return { text: value.reply };
}
const jsonEscapes: Record<string, string> = {
	'"': '"',
	"\\": "\\",
	"/": "/",
	b: "\b",
	f: "\f",
	n: "\n",
	r: "\r",
	t: "\t",
};
/**
 * The decoded part of `reply` that a partial `{"reply": "...` choice already fixes,
 * so a reply streams while the call path stays silent. Stops before an incomplete escape.
 */
export function codexReplyPrefix(partial: string): string {
	const head = /^\s*\{\s*"reply"\s*:\s*"/.exec(partial);
	if (!head) return "";
	let out = "";
	for (let i = head[0].length; i < partial.length;) {
		const c = partial[i]!;
		if (c === '"') break;
		if (c !== "\\") {
			out += c;
			i++;
			continue;
		}
		const e = partial[i + 1];
		if (e === undefined) break;
		if (e !== "u") {
			const decoded = jsonEscapes[e];
			if (decoded === undefined) break;
			out += decoded;
			i += 2;
			continue;
		}
		const hex = partial.slice(i + 2, i + 6);
		if (!/^[0-9a-fA-F]{4}$/.test(hex)) break;
		const code = parseInt(hex, 16);
		if (code >= 0xd800 && code <= 0xdbff) {
			// Emit a surrogate pair only when its low half has arrived.
			const low = /^\\u([dD][c-fC-F][0-9a-fA-F]{2})/.exec(
				partial.slice(i + 6, i + 12),
			);
			if (!low) break;
			out += String.fromCharCode(code, parseInt(low[1]!, 16));
			i += 12;
			continue;
		}
		out += String.fromCharCode(code);
		i += 6;
	}
	return out;
}

export async function runCodex(
	runtime: CodexRuntime,
	call: CloudAgentCall,
): Promise<CloudAgentResult> {
	const cwd = await mkdtemp(join(tmpdir(), AGENT_ROOT_PREFIX));
	const untrack = trackClaudeRoot(cwd);
	try {
		const { system, prompt, images } = promptParts(call.messages);

		const tools = call.tools?.length ? call.tools : undefined;
		// Without a key the CLI keeps its own login; a key binds the saved API host.
		const keyed: CodexRuntime = call.credential
			? {
					command: runtime.command,
					env: { ...runtime.env, CODEX_API_KEY: call.credential },
					extraArgs: ["-c", `openai_base_url=${JSON.stringify(call.baseUrl)}`],
				}
			: runtime;
		let streamed = "";
		const result = await runCodexTurn(
			keyed,
			{
				cwd,
				model: call.model,
				instructions:
					system +
					(tools
						? codexFunctions(tools)
						: call.outputSchema
							? systemContext(
									"inference.contexts.cloud-agents.structured-completion",
									{},
								)
							: ""),
				prompt,
				images,
				nativeWebSearch: call.nativeWebSearch,
				...(call.reasoningEffort
					? { reasoningEffort: call.reasoningEffort }
					: {}),
				...(tools
					? { outputSchema: codexChoiceSchema(tools) }
					: call.outputSchema
						? { outputSchema: call.outputSchema }
						: {}),
				signal: call.signal,
				onUsage: call.onUsage,
				onMessage: (text) => {
					// With tools the turn is a JSON choice: only its reply text streams.
					const visible = tools ? codexReplyPrefix(checkedText(text)) : text;
					if (!call.onDelta || !visible.startsWith(streamed)) return;
					const delta = visible.slice(streamed.length);
					if (delta) call.onDelta(delta);
					streamed = visible;
				},
			},
			fail,
		);
		call.signal.throwIfAborted();
		const final = checkedText(result.text);
		const choice = tools ? codexChoice(final, tools) : { text: final };
		if (!choice.toolCalls && !choice.text.trim()) throw fail("empty_output");
		// Deliver whatever the stream did not cover (no deltas, or a final tail).
		if (
			call.onDelta &&
			choice.text.startsWith(streamed) &&
			choice.text.length > streamed.length
		)
			call.onDelta(choice.text.slice(streamed.length));
		return {
			...choice,
			inputTokens: result.inputTokens,
			outputTokens: result.outputTokens,
			cacheReadTokens: result.cacheReadTokens,
			cacheCreationTokens: result.cacheCreationTokens,
			reasoningTokens: result.reasoningTokens,
			usageModel: result.usageModel,
		};
	} finally {
		await removeRoot(cwd, untrack);
	}
}
