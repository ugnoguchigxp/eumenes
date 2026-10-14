import type { ConnectionKind } from "../../../../api/domains/settings/contracts";

export const connectionKindLabels: Record<ConnectionKind, string> = {
	"openai-compatible": "OpenAI互換API",
	"codex-sdk": "Codex SDK",
	"claude-agent-sdk": "Claude Agent SDK",
	"claude-managed-agents": "Claude Managed Agents",
};
/** Prefilled values when a kind is chosen; all stay editable. */
export const connectionKindDefaults: Record<
	ConnectionKind,
	{ url: string; model: string; context: number }
> = {
	"openai-compatible": { url: "", model: "", context: 8192 },
	"codex-sdk": {
		url: "https://api.openai.com/v1",
		model: "gpt-6-luna",
		context: 200_000,
	},
	"claude-agent-sdk": {
		url: "https://api.anthropic.com",
		model: "claude-opus-5-5",
		context: 1_000_000,
	},
	"claude-managed-agents": {
		url: "https://api.anthropic.com",
		model: "claude-opus-5-5",
		context: 1_000_000,
	},
};
/**
 * Models offered in the conversation model picker for CLI-login SDK connections.
 * Fable and Astra are left out on purpose: their usage cost is too high for casual switching.
 */
export type CatalogKind = "codex-sdk" | "claude-agent-sdk";
export const agentModelCatalog: Record<
	CatalogKind,
	readonly { model: string; context: number }[]
> = {
	"codex-sdk": [
		{ model: "gpt-6.1-sol", context: 500_000 },
		{ model: "gpt-6-sol", context: 272_000 },
		{ model: "gpt-6-luna", context: 272_000 },
		{ model: "gpt-5.6-sol", context: 272_000 },
		{ model: "gpt-5.6-terra", context: 272_000 },
		{ model: "gpt-5.6-luna", context: 272_000 },
		{ model: "gpt-daybreak-blue-latest", context: 272_000 },
	],
	"claude-agent-sdk": [
		{ model: "claude-opus-5-5", context: 1_000_000 },
		{ model: "claude-sonnet-5-5", context: 1_000_000 },
		{ model: "claude-haiku-5-5", context: 1_000_000 },
		{ model: "claude-opus-5", context: 1_000_000 },
		{ model: "claude-sonnet-5", context: 1_000_000 },
	],
};
export const presentationLabel: Record<string, string> = {
	masculine: "（男性）",
	feminine: "（女性）",
	androgynous: "（中性）",
};
