import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClaudeObservation, ClaudeStart } from "../src/claude-contracts";
import { ClaudeService } from "../src/claude-service";
import { claudeRunnerClient } from "../src/claude-client";
import { servePrivateRunner } from "../src/sdk-server";
import {
	claudeCheckRequest,
	supervisedTools,
} from "../src/claude-supervised-tools";
import { claudeInputDigest } from "../src/contracts";
import { runClaudeExecution } from "../src/claude-engine";
import type { Options, query } from "@anthropic-ai/claude-agent-sdk";

function spec(
	mode: "read" | "verify" | "edit",
	path: string,
): ClaudeStart & { supervised: NonNullable<ClaudeStart["supervised"]> } {
	const workId = crypto.randomUUID();
	const deadline = Date.now() + 30_000;
	return {
		id: crypto.randomUUID(),
		workId,
		generation: 0,
		instruction: "Work on the fixture",
		priorExecutionId: null,
		deadline,
		maxTurns: 6,
		readOnly: mode === "read",
		supervised: {
			lease: {
				ownerRef: `claude-code-work:${workId}`,
				executorId: "claude-code-task",
				epoch: workId,
				slot: mode === "read" ? "read" : "edit",
			},
			authorization: {
				workspaceRef: "workspace",
				mode,
				checks: [],
				readablePaths: [path],
				writablePaths: [],
				deadline,
				targetRevision: "fixture",
			},
		},
	};
}

function fixture() {
	const root = mkdtempSync(
		join(realpathSync(tmpdir()), "claude-supervised-test-"),
	);
	const workspace = mkdtempSync(
		join(realpathSync(tmpdir()), "claude-workspace-test-"),
	);
	return {
		root,
		workspace,
		close() {
			rmSync(root, { recursive: true, force: true });
			rmSync(workspace, { recursive: true, force: true });
		},
	};
}

async function until<T>(predicate: () => T | undefined) {
	for (let i = 0; i < 400; i++) {
		const result = predicate();
		if (result !== undefined) return result;
		await Bun.sleep(5);
	}
	throw new Error("Timed out waiting for the fixture runner");
}

test.skipIf(process.platform !== "darwin")(
	"SDK hooks run the fixed sandboxed check and record only the actual passed exit after an edit",
	async () => {
		const f = fixture();
		const source = join(f.workspace, "source.txt");
		const original = join(f.workspace, "user.txt");
		const notes = join(f.workspace, "notes.txt");
		writeFileSync(notes, "調査結果".repeat(256));
		const added = join(f.workspace, "should-not-exist");
		const git = join(f.workspace, ".git");
		mkdirSync(git);
		writeFileSync(join(git, "sentinel"), "git metadata");
		writeFileSync(source, "incorrect");
		writeFileSync(original, "existing user edit");
		const check = {
			executable: "/bin/sh",
			args: ["-c", 'test "$(cat source.txt)" = correct'],
			cwd: f.workspace,
		};
		const writeAttempt = {
			executable: "/bin/sh",
			args: [
				"-c",
				[
					"if printf damage > source.txt; then exit 66; fi",
					"if printf create > should-not-exist; then exit 67; fi",
					"if printf change > .git/sentinel; then exit 68; fi",
					'printf cache > "$TMPDIR/check.out"',
				].join("\n"),
			],
			cwd: f.workspace,
		};
		const runScript = async (opts: Options, from: ClaudeStart) => {
			const options = opts.hooks!;
			const context = { signal: new AbortController().signal };
			const invoke = async (tool: string, raw: Record<string, unknown>) => {
				const id = crypto.randomUUID();
				const toolEvent = {
					session_id: "fixture",
					transcript_path: "",
					cwd: f.workspace,
					tool_name: tool,
					tool_use_id: id,
					tool_input: raw,
				};
				const before = await options.PreToolUse![0]!.hooks[0]!(
					{ ...toolEvent, hook_event_name: "PreToolUse" },
					id,
					context,
				);
				const detail =
					"hookSpecificOutput" in before
						? before.hookSpecificOutput
						: undefined;
				if (
					detail?.hookEventName !== "PreToolUse" ||
					detail.permissionDecision !== "allow"
				)
					return false;
				if (tool === "Write" || tool === "Read") {
					const input = detail.updatedInput!;
					if (tool === "Write")
						writeFileSync(input.file_path as string, input.content as string);
					await options.PostToolUse![0]!.hooks[0]!(
						{
							...toolEvent,
							hook_event_name: "PostToolUse",
							tool_response:
								tool === "Write"
									? "changed"
									: readFileSync(input.file_path as string, "utf8"),
						},
						id,
						context,
					);
					return true;
				}
				const outcome = spawnSync(
					"/bin/zsh",
					["-c", detail.updatedInput!.command as string],
					{ encoding: "utf8" },
				);
				if (
					outcome.status !== 0 &&
					from.supervised!.authorization.mode === "edit"
				)
					await options.PostToolUseFailure![0]!.hooks[0]!(
						{
							...toolEvent,
							hook_event_name: "PostToolUseFailure",
							error: outcome.stderr || "Nonzero exit",
						},
						id,
						context,
					);
				else
					await options.PostToolUse![0]!.hooks[0]!(
						{
							...toolEvent,
							hook_event_name: "PostToolUse",
							tool_response: {
								stdout: outcome.stdout,
								stderr: outcome.stderr,
								interrupted: false,
							},
						},
						id,
						context,
					);
				return outcome.status === 0;
			};
			expect(await invoke("Bash", { command: "printf unexpected" })).toBe(
				false,
			);
			if (from.supervised!.authorization.mode === "verify") {
				expect(
					await invoke("Write", { file_path: source, content: "forbidden" }),
				).toBe(false);
				expect(
					await invoke("Bash", { command: claudeCheckRequest(writeAttempt) }),
				).toBe(true);
				expect(readFileSync(source, "utf8")).toBe("incorrect");
				expect(existsSync(added)).toBe(false);
				expect(readFileSync(join(git, "sentinel"), "utf8")).toBe(
					"git metadata",
				);
				expect(
					await invoke("Bash", { command: claudeCheckRequest(check) }),
				).toBe(false);
				for (let n = 0; n < 25; n++)
					expect(await invoke("Read", { file_path: notes })).toBe(true);
			} else {
				expect(
					await invoke("Bash", { command: claudeCheckRequest(check) }),
				).toBe(false);
				expect(
					await invoke("Write", {
						file_path: original,
						content: "outside the grant",
					}),
				).toBe(false);
				expect(
					await invoke("Write", { file_path: source, content: "correct" }),
				).toBe(true);
				expect(
					await invoke("Bash", { command: claudeCheckRequest(check) }),
				).toBe(true);
			}
		};
		let runningSpec: ClaudeStart;
		let scriptFailure: unknown;
		const runner = new ClaudeService(
			f.root,
			f.workspace,
			(start) => {
				runningSpec = start;
				return {
					cwd: f.workspace,
					executable: "fixture",
					env: {},
					instruction: start.instruction,
					projectInstructions: "",
					deadline: start.deadline,
					maxTurns: start.maxTurns,
					tools: ["Read", "Glob", "Grep", "Write", "Edit", "Bash"],
					authorize: () => true,
					validateAccount: () => true,
				};
			},
			(input, signal) => {
				const running = runningSpec;
				const open = (({ options }) => {
					const child = options.spawnClaudeCodeProcess({
						command: "/bin/sleep",
						args: ["30"],
						env: {},
						cwd: f.workspace,
						signal,
					});
					return {
						accountInfo: async () => ({}),
						close: () => child.kill("SIGTERM"),
						async *[Symbol.asyncIterator]() {
							try {
								await runScript(options, running);
							} catch (error) {
								scriptFailure = error;
							}
							yield {
								type: "result",
								subtype: "success",
								is_error: false,
								result: "done",
								num_turns: 2,
							};
						},
					};
				}) satisfies (params: {
					options: Options & {
						spawnClaudeCodeProcess: NonNullable<
							Options["spawnClaudeCodeProcess"]
						>;
					};
				}) => unknown;
				return runClaudeExecution(
					input,
					signal,
					open as unknown as typeof query,
				);
			},
		);
		async function launch(start: ReturnType<typeof spec>) {
			runner.request({ operation: "start", spec: start });
			return until(() => {
				const result = runner.request({
					operation: "inspect",
					id: start.id,
				}) as ClaudeObservation;
				for (const request of result.toolRequests ?? [])
					runner.request({
						operation: "approve_tool",
						id: start.id,
						requestId: request.id,
						lease: start.supervised.lease,
					});
				if (result.managedExecutionStopped) return result;
			});
		}
		const host = await servePrivateRunner(
			join(f.root, "claude.sock"),
			"/claude",
			runner,
			"claude",
		);
		try {
			const verify = spec("verify", source);
			verify.supervised.authorization.readablePaths.push(notes);
			verify.supervised.authorization.checks = [writeAttempt, check];
			const isolated = await launch(verify);
			if (scriptFailure) throw scriptFailure;
			expect(
				isolated.structuredEvidence
					?.filter(({ kind }) => kind === "check")
					.map(({ kind, passed }) => [kind, passed]),
			).toEqual([
				["check", true],
				["check", false],
			]);
			expect(
				isolated.structuredEvidence?.filter(({ kind }) => kind === "read"),
			).toHaveLength(24);
			expect(Buffer.byteLength(JSON.stringify(isolated))).toBeGreaterThan(
				64 * 1024,
			);
			const client = claudeRunnerClient(host.socket, f.workspace);
			expect(await client.inspect(verify.id)).toEqual(isolated);
			const edit = spec("edit", source);
			edit.supervised.authorization.checks = [check];
			edit.supervised.authorization.writablePaths = [source];
			const executed = await launch(edit);
			if (scriptFailure) throw scriptFailure;
			const [before, written, after] = executed.structuredEvidence!;
			expect([before?.passed, written?.kind, after?.passed]).toEqual([
				false,
				"edit",
				true,
			]);
			expect(written?.executionId).toBe(edit.id);
			expect(after?.inputDigest).toBe(written?.inputDigest);
			expect(before?.inputDigest).not.toBe(after?.inputDigest);
			expect(after?.check).toEqual(check);
			expect(readFileSync(original, "utf8")).toBe("existing user edit");
			expect(readFileSync(source, "utf8")).toBe("correct");
		} finally {
			await host.close();
			f.close();
		}
	},
);

test.skipIf(process.platform !== "darwin")(
	"long repeated checks retain their latest result in a receipt that can be reopened",
	async () => {
		const f = fixture();
		const source = join(f.workspace, "input.txt");
		writeFileSync(source, "test input");
		const start = spec("verify", source);
		const check = {
			executable: "/usr/bin/true",
			cwd: f.workspace,
			args: Array<string>(32).fill("試".repeat(1_024)),
		};
		start.supervised.authorization.checks = [check];
		const prepare = () => ({
			cwd: f.workspace,
			executable: "fixture",
			env: {},
			instruction: start.instruction,
			projectInstructions: "",
			deadline: start.deadline,
			maxTurns: 1,
			tools: ["Bash"],
			authorize: () => true,
			validateAccount: () => true,
		});
		const engine: typeof runClaudeExecution = async (input) => {
			for (let seq = 1; seq <= 24; seq++)
				input.onEvidence(String(seq), "試験結果", {
					kind: "check",
					check,
					passed: seq < 24,
					targetRevision: "fixture",
					text: "試験結果",
					inputDigest: claudeInputDigest([source]),
				});
			return {
				result: { ok: true, text: "done", turns: 1 },
				managedExecutionStopped: true,
				aborted: false,
				evidenceCount: 24,
			};
		};
		let runner = new ClaudeService(f.root, f.workspace, prepare, engine);
		try {
			runner.request({ operation: "start", spec: start });
			await Promise.all([runner.close(), runner.close()]);
			runner = new ClaudeService(f.root, f.workspace, prepare, engine);
			const receipt = runner.request({
				operation: "inspect",
				id: start.id,
			}) as ClaudeObservation;
			expect(receipt.structuredEvidence?.at(-1)).toMatchObject({
				ref: `${start.id}:24`,
				passed: false,
				check,
			});
			expect(existsSync(join(f.root, start.id, "event-1.json"))).toBe(true);
		} finally {
			await runner.close();
			f.close();
		}
	},
);

test("a user change after admission prevents the next edit and preserves the current bytes", () => {
	const f = fixture();
	try {
		const source = join(f.workspace, "source.txt");
		writeFileSync(source, "starting version");
		const editing = spec("edit", source);
		editing.supervised.authorization.writablePaths = [source];
		editing.supervised.authorization.baselineInputDigest = claudeInputDigest([
			source,
		]);
		const tools = supervisedTools(editing, f.workspace);
		expect(
			tools.toolRequest("Write", {
				file_path: source,
				content: "proposed edit",
			}),
		).toBeDefined();
		writeFileSync(source, "user's in-flight edit");
		expect(
			tools.toolRequest("Write", {
				file_path: source,
				content: "proposed edit",
			}),
		).toBeUndefined();
		expect(readFileSync(source, "utf8")).toBe("user's in-flight edit");
		expect(() => supervisedTools(editing, f.workspace)).toThrow(
			"workspace_inputs_changed",
		);
	} finally {
		f.close();
	}
});

test("a blocked reader isolates new execution while a running editor remains observable and stoppable", async () => {
	const f = fixture();
	const reader = spec("read", f.workspace);
	const editor = spec("edit", f.workspace);
	const next = spec("edit", f.workspace);
	const legacy = {
		...spec("edit", f.workspace),
		supervised: undefined,
	};
	let confirmed = false;
	const runner = new ClaudeService(
		f.root,
		f.workspace,
		(start) => ({
			cwd: f.workspace,
			executable: "fixture",
			env: {},
			instruction: start.instruction,
			projectInstructions: "",
			deadline: start.deadline,
			maxTurns: start.maxTurns,
			tools: [],
			authorize: () => false,
			validateAccount: () => true,
		}),
		async (input, signal) => {
			await new Promise<void>((resolve) =>
				signal.addEventListener("abort", () => resolve(), { once: true }),
			);
			return {
				managedExecutionStopped: input.instruction !== "Hold the read slot",
				evidenceCount: 0,
				aborted: true,
				confirmStopped: () => confirmed,
			};
		},
	);
	const inspect = (start: ClaudeStart) =>
		runner.request({ operation: "inspect", id: start.id }) as ClaudeObservation;
	const stop = (start: ClaudeStart) =>
		runner.request({
			operation: "stop",
			id: start.id,
			operationId: crypto.randomUUID(),
			supervised: start.supervised,
		});
	try {
		reader.instruction = "Hold the read slot";
		expect(runner.request({ operation: "start", spec: reader })).toMatchObject({
			state: "running",
		});
		expect(() => runner.request({ operation: "start", spec: legacy })).toThrow(
			"claude_runner_unavailable",
		);
		expect(runner.request({ operation: "start", spec: editor })).toMatchObject({
			state: "running",
		});
		expect(runner.request({ operation: "start", spec: next })).toMatchObject({
			blocked: "runner_busy",
		});
		stop(reader);
		await until(() => (inspect(reader).state === "unknown" ? true : undefined));
		expect(inspect(editor)).toMatchObject({ state: "running" });
		expect(runner.request({ operation: "start", spec: next })).toMatchObject({
			blocked: "runner_quarantined",
		});
		const recover = {
			operation: "recover" as const,
			id: reader.id,
			lease: reader.supervised.lease,
			proof: "process_exit" as const,
		};
		expect(() => runner.request(recover)).toThrow(
			"claude_recovery_unconfirmed",
		);
		expect(() => runner.request({ ...recover, proof: "host_reboot" })).toThrow(
			"claude_recovery_unconfirmed",
		);
		confirmed = true;
		expect(() =>
			runner.request({
				...recover,
				lease: { ...recover.lease, epoch: crypto.randomUUID() },
			}),
		).toThrow("claude_recovery_mismatch");
		stop(editor);
		await until(() => (inspect(editor).state === "stopped" ? true : undefined));
		expect(runner.request(recover)).toMatchObject({
			state: "stopped",
			managedExecutionStopped: true,
		});
		expect(runner.request(recover)).toMatchObject({
			state: "stopped",
			managedExecutionStopped: true,
		});
		expect(runner.request({ operation: "start", spec: next })).toMatchObject({
			state: "running",
		});
		const cancelledBeforeStart = spec("read", f.workspace);
		expect(stop(cancelledBeforeStart)).toMatchObject({ state: "stopped" });
		expect(
			runner.request({ operation: "start", spec: cancelledBeforeStart }),
		).toMatchObject({ state: "stopped" });
		expect(
			runner.request({
				...recover,
				id: cancelledBeforeStart.id,
				lease: cancelledBeforeStart.supervised.lease,
			}),
		).toMatchObject({ state: "stopped" });
	} finally {
		await runner.close();
		f.close();
	}
});

test("runner questions use the absolute deadline until presented and preserve the first presented deadline", async () => {
	const f = fixture();
	const start = spec("read", f.workspace);
	const questionId = crypto.randomUUID();
	let replies = 0;
	const runner = new ClaudeService(
		f.root,
		f.workspace,
		() => ({
			cwd: f.workspace,
			executable: "fixture",
			env: {},
			instruction: start.instruction,
			projectInstructions: "",
			deadline: start.deadline,
			maxTurns: start.maxTurns,
			tools: [],
			authorize: () => false,
			validateAccount: () => true,
		}),
		async (input, signal) => {
			const answer = await input.ask(
				{
					id: questionId,
					prompt: "Which value?",
					expiresAt: Date.now() - 60_000,
				},
				signal,
			);
			if (answer) replies++;
			return {
				managedExecutionStopped: true,
				aborted: signal.aborted,
				evidenceCount: 0,
			};
		},
	);
	try {
		const waiting = runner.request({ operation: "start", spec: start });
		expect(waiting).toMatchObject({
			question: { presentation: "waiting", expiresAt: start.deadline },
		});
		const answer = {
			operation: "reply" as const,
			id: start.id,
			questionId,
			operationId: crypto.randomUUID(),
			answer: "A",
		};
		expect(() => runner.request(answer)).toThrow("claude_question_stale");
		const current = {
			operation: "present" as const,
			id: start.id,
			questionId,
			expiresAt: Date.now() + 10_000,
		};
		runner.request(current);
		expect(runner.request(current)).toMatchObject({
			question: { presentation: "presented", expiresAt: current.expiresAt },
		});
		expect(() =>
			runner.request({ ...current, expiresAt: current.expiresAt + 1_000 }),
		).toThrow("claude_operation_conflict");
		runner.request(answer);
		await until(() => (replies ? true : undefined));
		runner.request(answer);
		expect(replies).toBe(1);
	} finally {
		await runner.close();
		f.close();
	}
});

test.skipIf(process.platform !== "darwin")(
	"recovery needs either managed exit or a distinct boot identity on the same host",
	async () => {
		const f = fixture();
		const start = spec("read", f.workspace);
		const runner = () =>
			new ClaudeService(
				f.root,
				f.workspace,
				() => ({
					cwd: f.workspace,
					executable: "fixture",
					env: {},
					instruction: start.instruction,
					projectInstructions: "",
					deadline: start.deadline,
					maxTurns: start.maxTurns,
					tools: [],
					authorize: () => false,
					validateAccount: () => true,
				}),
				async () => ({
					managedExecutionStopped: false,
					aborted: true,
					evidenceCount: 0,
				}),
			);
		const recover = {
			operation: "recover" as const,
			id: start.id,
			lease: start.supervised.lease,
			proof: "host_reboot" as const,
		};
		let current = runner();
		try {
			current.request({ operation: "start", spec: start });
			await current.close();
			current = runner();
			expect(current.request({ operation: "health" })).toMatchObject({
				ready: false,
			});
			expect(() => current.request(recover)).toThrow(
				"claude_recovery_unconfirmed",
			);
			await current.close();

			// Emulate a persisted receipt from an earlier boot without rebooting this host.
			const file = join(f.root, start.id, "receipt.json");
			const receipt = JSON.parse(readFileSync(file, "utf8")) as {
				boot: { host: string; boot: string };
			};
			const sameHost = receipt.boot.host;
			receipt.boot.host = "another host";
			receipt.boot.boot = crypto.randomUUID();
			writeFileSync(file, JSON.stringify(receipt));
			current = runner();
			expect(() => current.request(recover)).toThrow(
				"claude_recovery_unconfirmed",
			);
			await current.close();

			receipt.boot.host = sameHost;
			writeFileSync(file, JSON.stringify(receipt));
			current = runner();
			expect(current.request(recover)).toMatchObject({
				state: "stopped",
				managedExecutionStopped: true,
			});
			expect(current.request({ operation: "health" })).toMatchObject({
				ready: true,
			});
		} finally {
			await current.close();
			f.close();
		}
	},
);
