import type { BillingPath } from "../../../../api/domains/settings/contracts";

/**
 * Context window registered for a subscription model whose size the provider does not report.
 * It is conservative on purpose and is learned after the first turn.
 */
export const UNKNOWN_CONTEXT_WINDOW = 200_000;

/** Billing-path names shown as picker group labels; an openai-compatible connection shows its own name. */
export const billingPathLabels: Record<
	Exclude<BillingPath, "larm" | "openai-compatible">,
	string
> = {
	"claude-subscription": "Claude（サブスク）",
	"claude-api-key": "Claude（API）",
	codex: "Codex",
	"cloudflare-workers-ai": "Cloudflare Workers AI",
};

export const presentationLabel: Record<string, string> = {
	masculine: "（男性）",
	feminine: "（女性）",
	androgynous: "（中性）",
};
