import { query } from "@anthropic-ai/claude-agent-sdk";
import { runClaudeAgent } from "./cloud-agent-claude";
import { runCodex } from "./cloud-agent-codex";
import { fail, safeAgentError, type CloudAgents } from "./cloud-agent-shared";
import type { CodexHost } from "./codex-host";
export {
	anthropicBase,
	anthropicFetch,
	claudeAgentEnv,
	startGatedQuery,
	withClaudeDirs,
} from "./cloud-agent-claude";
export { safeAgentError } from "./cloud-agent-shared";
export type {
	AgentSessionCall,
	CloudAgentKind,
	CloudAgents,
} from "./cloud-agent-shared";
export function createCloudAgents(
	environment: Readonly<Record<string, string | undefined>>,
	options: {
		/** The Codex processes and threads (undefined: Codex is not installed). */
		codexHost?: CodexHost;
		/** Test seam for the Claude Agent SDK entry point. */
		claudeQuery?: typeof query;
	} = {},
): CloudAgents {
	const codex = options.codexHost;
	return {
		forget: () => codex?.forget(),
		close: async () => {
			await codex?.close();
		},
		async run(call) {
			call.signal.throwIfAborted();
			try {
				if (call.kind === "codex-sdk") {
					if (!codex) throw fail("codex_unavailable");
					return await runCodex(codex, call);
				}
				return await runClaudeAgent(
					environment,
					call,
					options.claudeQuery ?? query,
				);
			} catch (error) {
				call.signal.throwIfAborted();
				throw safeAgentError(error);
			}
		},
	};
}
