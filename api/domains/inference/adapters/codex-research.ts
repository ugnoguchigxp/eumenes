import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Messages } from "../contracts";

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
		async execute(messages: Messages, signal: AbortSignal) {
			signal.throwIfAborted();
			const cwd = await mkdtemp(join(tmpdir(), "eumenes-research-"));
			try {
				signal.throwIfAborted();
				const child = spawn(
					command,
					[
						"exec",
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
						'developer_instructions="Follow the supplied system messages. Return exactly one JSON decision using OUTPUT_SCHEMA. Only Eumenes may execute the listed TOOLS. Do not use native tools, inspect files, or delegate to other agents."',
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
					if (bytes > 65536) fail("codex_research_output_limit");
					else output.push(Buffer.from(chunk));
				});
				// Provider output is neither logged nor persisted.
				child.stderr.resume();
				child.stdin.on("error", () => fail("codex_research_stdin_failed"));
				signal.addEventListener("abort", stop, { once: true });
				try {
					if (signal.aborted) stop();
					else child.stdin.end(JSON.stringify({ messages }));
					const code = await closed;
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
					if (!value) throw new Error("codex_research_empty_output");
					return value;
				} finally {
					signal.removeEventListener("abort", stop);
					kill("SIGKILL");
					clearTimeout(killTimer);
				}
			} finally {
				await rm(cwd, { recursive: true, force: true });
			}
		},
	};
}
