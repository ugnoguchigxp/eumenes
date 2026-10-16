import type { Settings } from "../../settings";

/**
 * The model Codex research runs on: the LLM resource of the saved Codex connection (the
 * route's cloud resource when it is one, otherwise the first enabled connection). Undefined
 * when none is saved, so Codex uses its own configured default.
 */
export function codexResearchModel(settings: Settings): string | undefined {
	const codex = (connectionId: string) =>
		settings.connections.some(
			(c) => c.id === connectionId && c.kind === "codex-sdk" && c.enabled,
		);
	const llm = settings.resources.filter(
		(r) => r.purpose === "llm" && codex(r.connectionId),
	);
	const routed = settings.routes.llm.fallbackId;
	return (llm.find((r) => r.id === routed) ?? llm[0])?.model;
}
