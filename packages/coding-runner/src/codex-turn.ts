import { Codex, type CodexOptions } from "@openai/codex-sdk";
import { accessSync, constants } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Tokens of one finished turn, as the Codex CLI counted them. */
export type CodexTurnUsage = {
	input: number;
	cachedInput: number;
	output: number;
	reasoning: number;
};
export type CodexTurnInput = {
	/** The codex executable and the only environment it may see. */
	command: string;
	env: Record<string, string>;
	/** Absent: Codex's own default model. */
	model?: string;
	reasoning: "low" | "medium" | "high";
	/** Codex's own web search of the turn. */
	webSearch: "disabled" | "cached" | "live";
	/** Structured `--config` overrides and raw `key=value` overrides for the CLI. */
	config?: NonNullable<CodexOptions["config"]>;
	configOverrides?: string[];
	prompt: string;
	signal: AbortSignal;
};
export type CodexTurnResult = {
	text: string;
	/** Web searches Codex ran in the turn. */
	searches: number;
	usage: CodexTurnUsage | null;
};

/**
 * One prompt to a fresh Codex thread in a private, read-only directory, answered with its final message. The thread
 * is never resumed: nothing of the turn outlives the call except what the CLI keeps by its own settings. An abort of
 * `signal` ends the turn (the SDK stops the CLI).
 */
export async function runCodexTurn(
	input: CodexTurnInput,
): Promise<CodexTurnResult> {
	input.signal.throwIfAborted();
	// The SDK waits forever on an executable that cannot start: fail here, with the system's own code.
	accessSync(input.command, constants.X_OK);
	const directory = await mkdtemp(join(tmpdir(), "eumenes-codex-turn-"));
	try {
		const codex = new Codex({
			codexPathOverride: input.command,
			env: input.env,
			...(input.config ? { config: input.config } : {}),
			...(input.configOverrides
				? { configOverrides: input.configOverrides }
				: {}),
		});
		const thread = codex.startThread({
			...(input.model ? { model: input.model } : {}),
			modelReasoningEffort: input.reasoning,
			webSearchMode: input.webSearch,
			sandboxMode: "read-only",
			approvalPolicy: "never",
			skipGitRepoCheck: true,
			workingDirectory: directory,
		});
		const turn = await thread.run(input.prompt, { signal: input.signal });
		input.signal.throwIfAborted();
		return {
			text: turn.finalResponse,
			searches: turn.items.filter((item) => item.type === "web_search").length,
			usage: turn.usage
				? {
						input: turn.usage.input_tokens,
						cachedInput: turn.usage.cached_input_tokens,
						output: turn.usage.output_tokens,
						reasoning: turn.usage.reasoning_output_tokens,
					}
				: null,
		};
	} finally {
		await rm(directory, { recursive: true, force: true }).catch(() => {});
	}
}
