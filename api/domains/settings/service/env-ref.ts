/** Official API hosts a provider key may be sent to; any other host needs an explicit allowlist. */
export const providerKeyHosts: Record<string, (host: string) => boolean> = {
	OPENAI_API_KEY: (h) => h === "api.openai.com",
	ANTHROPIC_API_KEY: (h) => h === "api.anthropic.com",
	GEMINI_API_KEY: (h) => h === "generativelanguage.googleapis.com",
	GOOGLE_API_KEY: (h) => h === "generativelanguage.googleapis.com",
	AZURE_OPENAI_API_KEY: (h) =>
		/^[a-z0-9][a-z0-9-]{0,62}\.openai\.azure\.com$/.test(h),
	GROQ_API_KEY: (h) => h === "api.groq.com",
	MISTRAL_API_KEY: (h) => h === "api.mistral.ai",
	DEEPSEEK_API_KEY: (h) => h === "api.deepseek.com",
};
/** A connection may only name an environment variable meant for cloud credentials, bound to its host. */
export function isAllowedEnvRef(
	name: string,
	allowlist: readonly string[],
	baseUrl: string,
): boolean {
	if (name.startsWith("EUMENES_CLOUD_") || allowlist.includes(name))
		return true;
	const hostRule = Object.hasOwn(providerKeyHosts, name)
		? providerKeyHosts[name]
		: undefined;
	if (!hostRule) return false;
	try {
		return hostRule(new URL(baseUrl).hostname);
	} catch {
		return false;
	}
}
