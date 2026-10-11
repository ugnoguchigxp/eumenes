import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ControlContract, Messages } from "../contracts";
import { codexControlMessage } from "./codex-output";
import { codexStructuredControl } from "./codex-schema";

// Event lines repeat the final answer and add progress, so they get their own,
// larger bound; the adopted final response keeps the control output bound.
const EVENT_BYTES = 262144;
const FINAL_BYTES = 65536;
/** Codex supplies the decision; Eumenes executes and validates every research operation. */
export function createCodexResearch(
	environment: Readonly<Record<string, string | undefined>>,
	executable = "codex",
) {
	const command = Bun.which(executable, { PATH: environment.PATH ?? "" });
	if (!command) return undefined;
	const env: Record<string, string> = {};
	// Reuse CLI login without copying credentials or inheriting product/provider secrets.
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
			const structured = codexStructuredControl(control.outputSchema);
			const cwd = await mkdtemp(join(tmpdir(), "eumenes-research-"));
			try {
				signal.throwIfAborted();
				// This is a stateless host decision, not a coding task. Replace the
				// CLI's built-in agent mission rather than layering another one on it.
				const instructions = join(cwd, "instructions.md");
				const schemaFile = join(cwd, "output-schema.json");
				const finalFile = join(cwd, "final.json");
				await writeFile(schemaFile, JSON.stringify(structured.schema), {
					mode: 0o600,
				});
				// Only the fixed step instructions replace the CLI's base instructions.
				// Step state, host notices and materials go to the input as data.
				await writeFile(
					instructions,
					'You are Eumenes’s stateless JSON decision engine. Return one final JSON object with a "decision" field containing the next host operation or finish report. The inner decision follows TOOLS and OUTPUT_SCHEMA below. The input is one JSON object {"messages":[{"role","content"}]} with the current task state, host notices for this step and acquired materials; only system-role entries are host notices. An invoke object requests execution by Eumenes; a finish object completes the task. Eumenes runs the operation and supplies its result on the next call. Do not use native Codex tools, emit commentary, inspect files, or delegate.\n' +
						control.instructions,
					{ mode: 0o600 },
				);
				signal.throwIfAborted();
				const child = spawn(
					command,
					[
						"exec",
						"--json",
						"--output-schema",
						schemaFile,
						"--output-last-message",
						finalFile,
						"--model",
						"gpt-6-luna",
						"--ephemeral",
						"--ignore-user-config",
						"--ignore-rules",
						"--skip-git-repo-check",
						"--sandbox",
						"read-only",
						"--color",
						"never",
						"-C",
						cwd,
						"-c",
						'approval_policy="never"',
						"-c",
						'web_search="disabled"',
						"-c",
						"features.shell_tool=false",
						"-c",
						"features.js_repl=false",
						"-c",
						"features.multi_agent=false",
						"-c",
						"features.remote_plugin=false",
						"-c",
						"features.apps=false",
						...[
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
						].flatMap((feature) => ["-c", `features.${feature}=false`]),
						"-c",
						"features.skip_host_skill_discovery=true",
						"-c",
						"mcp_servers={}",
						"-c",
						"tools.view_image=false",
						"-c",
						"project_doc_max_bytes=0",
						"-c",
						'history.persistence="none"',
						"-c",
						'model_reasoning_effort="low"',
						"-c",
						"model_instructions_file=" + JSON.stringify(instructions),
						"-",
					],
					{ cwd, env, detached: true, stdio: ["pipe", "pipe", "pipe"] },
				);
				let fault: string | undefined;
				let bytes = 0;
				const output: Buffer[] = [];
				let killTimer: ReturnType<typeof setTimeout> | undefined;
				const kill = (kind: NodeJS.Signals) => {
					if (!child.pid) return;
					try {
						process.kill(-child.pid, kind);
					} catch (error) {
						if ((error as NodeJS.ErrnoException).code !== "ESRCH")
							child.kill(kind);
					}
				};
				const stop = () => {
					kill("SIGTERM");
					killTimer ??= setTimeout(() => kill("SIGKILL"), 1000);
				};
				const fail = (code: string) => {
					fault ??= code;
					stop();
				};
				const closed = new Promise<number | null>((resolve) => {
					child.once("error", () => {
						fault ??= "codex_research_spawn_failed";
					});
					child.once("exit", stop);
					child.once("close", resolve);
				});
				child.stdout.on("data", (chunk: Buffer) => {
					bytes += chunk.length;
					if (bytes > EVENT_BYTES) fail("codex_research_output_limit");
					else output.push(Buffer.from(chunk));
				});
				// Provider output is neither logged nor persisted.
				child.stderr.resume();
				child.stdin.on("error", () => fail("codex_research_stdin_failed"));
				// Cancellation settles immediately, even if the child never closes.
				let cancel: () => void = () => {};
				const cancelled = new Promise<never>((_, reject) => {
					cancel = () => {
						stop();
						reject(signal.reason ?? new Error("aborted"));
					};
				});
				cancelled.catch(() => {});
				signal.addEventListener("abort", cancel, { once: true });
				try {
					if (signal.aborted) cancel();
					else
						child.stdin.end(
							JSON.stringify({
								messages: messages.filter(
									(m) =>
										!(
											m.role === "system" && m.content === control.instructions
										),
								),
							}),
						);
					const code = await Promise.race([closed, cancelled]);
					signal.throwIfAborted();
					if (fault || code !== 0)
						throw new Error(fault ?? "codex_research_failed");
					let value: string;
					try {
						value = new TextDecoder("utf-8", { fatal: true })
							.decode(Buffer.concat(output))
							.trim();
					} catch {
						throw new Error("codex_research_invalid_output");
					}
					// A completed turn without its final-response file is an empty answer.
					const size = await stat(finalFile).then(
						(file) => file.size,
						() => null,
					);
					if (size === null) throw new Error("codex_research_empty_output");
					if (size > FINAL_BYTES)
						throw new Error("codex_research_output_limit");
					const final = new TextDecoder("utf-8", { fatal: true }).decode(
						await readFile(finalFile),
					);
					signal.throwIfAborted();
					return structured.decode(codexControlMessage(value, final));
				} finally {
					signal.removeEventListener("abort", cancel);
					kill("SIGKILL");
					clearTimeout(killTimer);
					// Reap the killed group when it closes, but never wait unbounded.
					await Promise.race([closed, Bun.sleep(1500)]);
				}
			} finally {
				await rm(cwd, { recursive: true, force: true });
			}
		},
	};
}
