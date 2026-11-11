import { runCodexTurn } from "../../../packages/coding-runner/src/codex-turn";
import {
	codexRuntime,
	disabledFeatures,
	type InferencePort,
} from "../../domains/inference";
import type { WebNoteDeps } from "../../domains/web-note";

/**
 * The research note task's Codex: the codex executable and the only environment it may see (`codexRuntime`), no
 * native tools (the code mode host stays: the search needs it), MCP, plugins, project docs or history, and Codex's
 * own web search as the turn asks. The model is the web note's own (its policy), not a setting. No executable: no
 * turn is offered, and the task is not offered either.
 */
export function createCodexWebNote(
	environment: Readonly<Record<string, string | undefined>>,
	executable: string | undefined,
	inference: Pick<InferencePort, "recordExternalCodexAttempt">,
	/** Test seam for the Codex SDK entry point. */
	run: typeof runCodexTurn = runCodexTurn,
): Pick<WebNoteDeps, "turn" | "record"> {
	const runtime = codexRuntime(environment, executable);
	// Codex's web search runs through its code mode host: with that off, the turn has no search and answers that it
	// could not search (2026-11-11, codex-sdk 0.160 and the research model: 0 searches with it off, 1-3 with it on). With the shell,
	// JS REPL and the rest off, the host has no tool but the search to call.
	const { code_mode_host: _searchHost, ...features } = disabledFeatures;
	return {
		...(runtime
			? {
					turn: (call) =>
						run({
							command: runtime.command,
							env: runtime.env,
							model: call.model,
							reasoning: call.reasoning,
							webSearch: call.webSearch,
							config: {
								features: {
									...features,
									skip_host_skill_discovery: true,
								},
								project_doc_max_bytes: 0,
								history: { persistence: "none" },
							},
							configOverrides: ["mcp_servers={}"],
							prompt: call.prompt,
							signal: call.signal,
						}),
				}
			: {}),
		record: async (attempt) => inference.recordExternalCodexAttempt?.(attempt),
	};
}
