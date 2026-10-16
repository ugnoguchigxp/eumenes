import type { SdkGitResult, SdkSnapshot } from "./sdk-git-contracts";
import { Codex, type CodexOptions, type ThreadEvent } from "@openai/codex-sdk";
import { chmodSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { atomicWrite, optionalJson, readPrivate } from "./storage";
import { sdkGitPhaseSchema } from "./sdk-git-contracts";
import { SENSITIVE_FILE_GLOBS } from "./sdk-sensitive-files";
import {
	sdkOutputSchema,
	sdkReportSchema,
	type SdkActivity,
	type SdkConfig,
	type SdkReport,
	type SdkSpec,
} from "./sdk-contracts";

export type SdkEngine = (input: {
	spec: SdkSpec;
	config: SdkConfig;
	directory: string;
	signal: AbortSignal;
	gitPhaseFile?: string;
	onGit?: (proof: SdkGitResult) => void;
	onThread: (id: string) => void;
	onActivity: (event: Omit<SdkActivity, "seq" | "at">) => void;
}) => Promise<{
	report?: SdkReport;
	failure?: string;
	managedExecutionStopped: boolean;
	snapshot?: SdkSnapshot;
	git?: SdkGitResult;
	gitEligible?: boolean;
}>;
type ConfigTable = NonNullable<CodexOptions["config"]>;
function inlineToml(table: ConfigTable): string {
	return `{${Object.entries(table)
		.map(
			([key, value]) =>
				`${JSON.stringify(key)}=${typeof value === "object" && !Array.isArray(value) ? inlineToml(value) : JSON.stringify(value)}`,
		)
		.join(",")}}`;
}
function client(config: SdkConfig, directory: string, gitPhaseFile?: string) {
	const approvedTool = gitPhaseFile
		? sdkGitPhaseSchema.parse(JSON.parse(readPrivate(gitPhaseFile))).phase ===
			"commit"
			? "approved_commit"
			: "approved_push"
		: undefined;
	const command = Bun.which("codex");
	if (!command) throw new Error("sdk_cli_unavailable");
	const launcher = join(directory, "launcher");
	atomicWrite(
		launcher,
		`#!${process.execPath}\nimport { launch } from ${JSON.stringify(fileURLToPath(new URL("./sdk-transport.ts", import.meta.url)))};\nlaunch(${JSON.stringify(command)}, ${JSON.stringify(directory)});\n`,
	);
	chmodSync(launcher, 0o700);
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
	const filesystem: ConfigTable = {
		":minimal": "read",
		":workspace_roots": {
			".": gitPhaseFile ? "read" : "write",
			".git": "read",
			".agents": "read",
			".codex": "read",
			".aws": "read",
			...Object.fromEntries(
				SENSITIVE_FILE_GLOBS.map((glob) => [glob, "deny" as const]),
			),
		},
		[env.CODEX_HOME ?? join(env.HOME!, ".codex")]: "deny",
		[config.root]: "deny",
	};
	for (const path of config.protectedPaths) filesystem[path] = "deny";
	return new Codex({
		codexPathOverride: launcher,
		env,
		config: {
			default_permissions: "eumenes-task",
			permissions: { "eumenes-task": { network: { enabled: false } } },
			features: {
				multi_agent: false,
				multi_agent_v2: false,
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
		},
		configOverrides: [
			gitPhaseFile
				? `mcp_servers=${inlineToml({ approved_git: { command: process.execPath, args: [fileURLToPath(new URL("./sdk-git-mcp.ts", import.meta.url)), gitPhaseFile], ...(process.env.SSH_AUTH_SOCK ? { env: { SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK } } : {}), required: true, enabled_tools: [approvedTool!], default_tools_approval_mode: "prompt", tools: { [approvedTool!]: { approval_mode: "approve" } }, startup_timeout_sec: 10, tool_timeout_sec: 90 } })}`
				: "mcp_servers={}",
			`permissions.eumenes-task.filesystem=${inlineToml(filesystem)}`,
		],
	});
}
function activity(event: ThreadEvent): Omit<SdkActivity, "seq" | "at"> {
	if (!("item" in event)) return { type: event.type };
	const item = event.item;
	return {
		type: event.type,
		itemType: item.type,
		itemId: item.id.slice(0, 120),
		...("status" in item ? { status: item.status } : {}),
		...(item.type === "command_execution"
			? {
					exitCode: item.exit_code,
					outputBytes: Buffer.byteLength(item.aggregated_output),
				}
			: {}),
	};
}

/** Iterator and AbortController live in the independent runner, never in the backend. */
export const nativeSdkEngine: SdkEngine = async ({
	spec,
	config,
	directory,
	signal,
	onThread,
	onActivity,
	gitPhaseFile,
}) => {
	let failure: string | undefined;
	let finalResponse = "";
	let completed = false;
	try {
		const codex = client(config, directory, gitPhaseFile);
		const options = {
			workingDirectory: config.workspaces[spec.workspaceId]!,
			approvalPolicy: "never" as const,
			webSearchMode: "disabled" as const,
			model: spec.model,
			modelReasoningEffort: spec.effort,
		};
		const thread = spec.threadId
			? codex.resumeThread(spec.threadId, options)
			: codex.startThread(options);
		const stream = await thread.runStreamed(spec.prompt, {
			outputSchema: sdkOutputSchema,
			signal,
		});
		for await (const event of stream.events) {
			if (event.type === "thread.started") {
				if (spec.threadId && spec.threadId !== event.thread_id)
					throw new Error("sdk_thread_mismatch");
				onThread(event.thread_id);
			}
			onActivity(activity(event));
			if (
				event.type === "item.completed" &&
				event.item.type === "agent_message"
			)
				finalResponse = event.item.text;
			if (event.type === "turn.completed") completed = true;
			if (event.type === "error" || event.type === "turn.failed")
				failure = "sdk_turn_failed";
		}
	} catch {
		failure = signal.aborted ? "sdk_aborted" : "sdk_execution_failed";
	}
	const process = optionalJson<{
		state: string;
		cliExited: boolean;
		stopReason?: string;
		observedProcessesStopped: boolean;
	}>(join(directory, "process.json"));
	const managedExecutionStopped =
		process?.state === "closed" &&
		process.cliExited &&
		process.observedProcessesStopped;
	if (process?.stopReason && !signal.aborted)
		failure = `sdk_${process.stopReason}`;
	if (!completed && !failure) failure = "sdk_turn_incomplete";
	if (failure) return { failure, managedExecutionStopped };
	try {
		return {
			report: sdkReportSchema.parse(JSON.parse(finalResponse)),
			managedExecutionStopped,
		};
	} catch {
		return { failure: "sdk_report_invalid", managedExecutionStopped };
	}
};
