import { runCodexTurn } from "../../../packages/coding-runner/src/codex-turn";
import {
	codexRuntime,
	disabledFeatures,
	type InferencePort,
} from "../../domains/inference";
import type { SettingsService } from "../../domains/settings";
import type { WebNoteDeps } from "../../domains/web-note";

/**
 * The model of the research notes: the model of the saved resource `agency.searchResourceId` names, which must be on
 * an enabled Codex SDK connection. Unset: Codex's own default (null). A resource that is gone or on another kind of
 * connection is an error: no other model takes its place.
 */
export function searchModel(
	settings: Pick<SettingsService, "get">,
): string | null {
	const current = settings.get();
	const id = current.agency.searchResourceId;
	if (!id) return null;
	const resource = current.resources.find((r) => r.id === id);
	const connection = current.connections.find(
		(c) => c.id === resource?.connectionId,
	);
	if (
		!resource ||
		resource.purpose !== "llm" ||
		!connection?.enabled ||
		connection.kind !== "codex-sdk"
	)
		throw new Error("web_note_search_resource_invalid");
	return resource.model;
}

/**
 * The research note task's Codex: the codex executable and the only environment it may see (`codexRuntime`), no
 * native tools (the code mode host stays: the search needs it), MCP, plugins, project docs or history, and Codex's own web search as the turn asks. No executable:
 * no turn is offered, and the task is not offered either.
 */
export function createCodexWebNote(
	environment: Readonly<Record<string, string | undefined>>,
	executable: string | undefined,
	inference: Pick<InferencePort, "recordExternalCodexAttempt">,
	settings: Pick<SettingsService, "get">,
	/** Test seam for the Codex SDK entry point. */
	run: typeof runCodexTurn = runCodexTurn,
): Pick<WebNoteDeps, "turn" | "record" | "model"> {
	const runtime = codexRuntime(environment, executable);
	// Codex's web search runs through its code mode host: with that off, the turn has no search and answers that it
	// could not search (2026-11-11, codex-sdk 0.160 / Luna: 0 searches with it off, 1-3 with it on). With the shell,
	// JS REPL and the rest off, the host has no tool but the search to call.
	const { code_mode_host: _searchHost, ...features } = disabledFeatures;
	return {
		...(runtime
			? {
					turn: (call) =>
						run({
							command: runtime.command,
							env: runtime.env,
							...(call.model ? { model: call.model } : {}),
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
		model: () => searchModel(settings),
		record: async (attempt) => inference.recordExternalCodexAttempt?.(attempt),
	};
}
