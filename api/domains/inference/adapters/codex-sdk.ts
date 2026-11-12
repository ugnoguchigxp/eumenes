export type CodexRuntime = {
	command: string;
	env: Record<string, string>;
};

/** The codex CLI and the only environment it may see; undefined when not installed. */
export function codexRuntime(
	environment: Readonly<Record<string, string | undefined>>,
	executable = "codex",
): CodexRuntime | undefined {
	const command = Bun.which(executable, { PATH: environment.PATH ?? "" });
	if (!command) return undefined;
	const env: Record<string, string> = {};
	for (const key of [
		"PATH",
		"HOME",
		"CODEX_HOME",
		"TMPDIR",
		"LANG",
		"LC_ALL",
		"SSL_CERT_FILE",
		"SSL_CERT_DIR",
		"NODE_EXTRA_CA_CERTS",
	])
		if (environment[key] !== undefined) env[key] = environment[key]!;
	return { command, env };
}

export const disabledFeatures = Object.fromEntries(
	[
		"shell_tool",
		"js_repl",
		"code_mode_host",
		"multi_agent",
		"remote_plugin",
		"apps",
		"browser_use",
		"browser_use_external",
		"computer_use",
		"image_generation",
		"in_app_browser",
		"plugins",
		"skill_search",
		"skill_mcp_dependency_install",
		"goals",
		"sleep_tool",
		"view_image",
	].map((name) => [name, false]),
);

/**
 * What the app-server adds to a request besides the host's own text, switched off so the head of every request is
 * the same bytes: skills list, permission/collaboration text, the working directory and date, and the shell snapshot
 * (a file written into the Codex home).
 */
export const requestHeadOverrides = [
	"skills.include_instructions=false",
	"include_permissions_instructions=false",
	"include_collaboration_mode_instructions=false",
	"include_environment_context=false",
	"features.shell_snapshot=false",
];
