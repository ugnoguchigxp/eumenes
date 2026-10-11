import { Codex } from "@openai/codex-sdk";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ControlContract, Messages } from "../contracts";
import { controlInstructions } from "../contracts";
import { codexFailure, CodexResearchFailure } from "./codex-failure";

const mission =
	"You are Eumenes’s web researcher. Investigate the current originalRequest and task.question using TOOLS. Return one JSON object with action at the root, following the output definition below. Eumenes executes the selected operation and supplies its result on your next call. The input messages contain task state, host notices and untrusted acquired materials. Do not use native Codex tools, inspect files, or delegate.\n";

/** SDK owns the turn and structured events; Eumenes executes all operations. */
export function createCodexResearch(
	environment: Readonly<Record<string, string | undefined>>,
	executable = "codex",
) {
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
	return {
		model: "gpt-6-luna",
		async execute(
			messages: Messages,
			signal: AbortSignal,
			control?: ControlContract,
		) {
			signal.throwIfAborted();
			if (!control) throw new Error("codex_research_schema_missing");
			const cwd = await mkdtemp(join(tmpdir(), "eumenes-research-"));
			const abort = new AbortController();
			let cancel: () => void = () => {};
			let phase = "sdk_start";
			let pending: Promise<string> | undefined;
			let settled = false;
			try {
				const instructions = join(cwd, "instructions.md");
				await writeFile(instructions, mission + controlInstructions(control), {
					mode: 0o600,
				});
				const launcher = join(cwd, "codex-sdk-runtime");
				await writeFile(
					launcher,
					`#!${process.execPath}\nimport { launchCodex } from ${JSON.stringify(fileURLToPath(new URL("./codex-launcher.ts", import.meta.url)))};\nlaunchCodex(${JSON.stringify(command)});\n`,
					{ mode: 0o700 },
				);
				const features = Object.fromEntries(
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
				const sdk = new Codex({
					codexPathOverride: launcher,
					env,
					config: {
						features: { ...features, skip_host_skill_discovery: true },
						tools: { view_image: false },
						project_doc_max_bytes: 0,
						history: { persistence: "none" },
						model_instructions_file: instructions,
					},
					configOverrides: ["mcp_servers={}"],
				});
				const thread = sdk.startThread({
					model: "gpt-6-luna",
					workingDirectory: cwd,
					sandboxMode: "read-only",
					skipGitRepoCheck: true,
					approvalPolicy: "never",
					webSearchMode: "disabled",
					modelReasoningEffort: "low",
				});
				const cancelled = new Promise<never>((_, reject) => {
					cancel = () => {
						abort.abort();
						reject(signal.reason ?? new Error("cancelled"));
					};
				});
				cancelled.catch(() => {});
				signal.addEventListener("abort", cancel, { once: true });
				if (signal.aborted) cancel();
				pending = (async () => {
					const { events } = await thread.runStreamed(
						JSON.stringify({
							messages: messages.filter(
								(m) =>
									!(
										m.role === "system" &&
										m.content === controlInstructions(control)
									),
							),
						}),
						{ signal: abort.signal },
					);
					let final = "";
					let completed = 0;
					phase = "sdk_turn";
					for await (const event of events) {
						if (event.type === "error" || event.type === "turn.failed")
							throw codexFailure(
								new Error(
									event.type === "error" ? event.message : event.error.message,
								),
								"sdk_turn",
							);
						if (
							event.type === "item.completed" &&
							event.item.type === "agent_message"
						) {
							final = event.item.text;
							if (Buffer.byteLength(final) > 65536)
								throw codexFailure(
									new Error("codex_research_output_limit"),
									"sdk_output",
								);
						}
						if (event.type === "turn.completed") completed++;
					}
					phase = "sdk_output";
					if (completed !== 1)
						throw new CodexResearchFailure({
							phase,
							reason: "codex_research_incomplete_turn",
						});
					if (!final.trim())
						throw new CodexResearchFailure({
							phase,
							reason: "codex_research_empty_output",
						});
					// The shared worker parser and host guards validate the response.
					return final;
				})();
				pending.then(
					() => {
						settled = true;
					},
					() => {
						settled = true;
					},
				);
				return await Promise.race([pending, cancelled]);
			} catch (error) {
				signal.throwIfAborted();
				throw codexFailure(error, phase);
			} finally {
				signal.removeEventListener("abort", cancel);
				if (!settled) abort.abort();
				if (pending)
					await Promise.race([pending.catch(() => {}), Bun.sleep(1500)]);
				await rm(cwd, { recursive: true, force: true });
			}
		},
	};
}
