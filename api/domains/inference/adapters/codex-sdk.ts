import { Codex } from "@openai/codex-sdk";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export type CodexRuntime = { command: string; env: Record<string, string> };

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

const disabledFeatures = Object.fromEntries(
	[
		"shell_tool",
		"js_repl",
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

/** A Codex client without native tools, plugins, MCP, project docs or history.
 * `cwd` is a private temporary directory that receives the instructions and launcher. */
export async function lockedCodex(
	runtime: CodexRuntime,
	cwd: string,
	instructions: string,
	auth?: { apiKey?: string; baseUrl?: string },
) {
	const instructionsFile = join(cwd, "instructions.md");
	await writeFile(instructionsFile, instructions, { mode: 0o600 });
	const launcher = join(cwd, "codex-sdk-runtime");
	await writeFile(
		launcher,
		`#!${process.execPath}\nimport { launchCodex } from ${JSON.stringify(fileURLToPath(new URL("./codex-launcher.ts", import.meta.url)))};\nlaunchCodex(${JSON.stringify(runtime.command)});\n`,
		{ mode: 0o700 },
	);
	return new Codex({
		codexPathOverride: launcher,
		env: runtime.env,
		...(auth?.apiKey ? { apiKey: auth.apiKey } : {}),
		...(auth?.baseUrl ? { baseUrl: auth.baseUrl } : {}),
		config: {
			features: { ...disabledFeatures, skip_host_skill_discovery: true },
			tools: { view_image: false },
			project_doc_max_bytes: 0,
			history: { persistence: "none" },
			model_instructions_file: instructionsFile,
		},
		configOverrides: ["mcp_servers={}"],
	});
}
