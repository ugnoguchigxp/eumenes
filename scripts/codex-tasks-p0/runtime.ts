import { Codex, type CodexOptions } from "@openai/codex-sdk";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
type CodexConfigObject = NonNullable<CodexOptions["config"]>;

/** P0 only: no research launcher, ephemeral session, or product settings writes. */
export async function probeClient(
	directory: string,
	workspace: string,
	git = false,
	remote?: string,
) {
	const command = Bun.which("codex");
	if (!command) throw new Error("codex_unavailable");
	const launcher = join(directory, "launcher");
	await writeFile(
		launcher,
		`#!${process.execPath}\nimport { launch } from ${JSON.stringify(fileURLToPath(new URL("./transport.ts", import.meta.url)))};\nlaunch(${JSON.stringify(command)}, ${JSON.stringify(directory)});\n`,
		{ mode: 0o700 },
	);
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
		if (process.env[key] !== undefined) env[key] = process.env[key]!;
	const codexHome = env.CODEX_HOME ?? join(env.HOME!, ".codex");
	const filesystem: CodexConfigObject = {
		":minimal": "read",
		":workspace_roots": {
			".": "write",
			".git": git ? "write" : "read",
			".agents": "read",
			".codex": "read",
			".aws": "read",
			private: "deny",
			"**/*.env": "deny",
		},
		[codexHome]: "deny",
		[resolve("data")]: "deny",
		[resolve(".env")]: "deny",
	};
	if (remote) filesystem[remote] = "write";
	return new Codex({
		codexPathOverride: launcher,
		env,
		config: {
			default_permissions: "task-probe",
			features: {
				multi_agent: false,
				remote_plugin: false,
				apps: false,
				plugins: false,
				browser_use: false,
				browser_use_external: false,
				computer_use: false,
				image_generation: false,
				in_app_browser: false,
				skill_search: false,
				skill_mcp_dependency_install: false,
			},
			permissions: { "task-probe": { network: { enabled: false } } },
		},
		configOverrides: [
			"mcp_servers={}",
			`permissions.task-probe.filesystem=${inlineToml(filesystem)}`,
		],
	});
}

// SDK's dotted-path flattening cannot express path/glob keys in filesystem tables.
function inlineToml(value: CodexConfigObject): string {
	return `{${Object.entries(value)
		.map(
			([key, entry]) =>
				`${JSON.stringify(key)}=${typeof entry === "object" && !Array.isArray(entry) ? inlineToml(entry) : JSON.stringify(entry)}`,
		)
		.join(",")}}`;
}
