import { expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	Options,
	Query,
	SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { claudeRunnerClient } from "../src/claude-client";
import { runClaudeExecution } from "../src/claude-engine";
import { evaluateOrdinaryToolAuthorization } from "../src/claude-policy";
import { isPermissionApproved } from "../src/claude-questions";
import { serveClaudeRunner } from "../src/claude-server";
import { ClaudeService } from "../src/claude-service";
import type { ClaudeObservation, ClaudeStart } from "../src/claude-contracts";

test("ordinary tool authorization separates auto-allow, user-ask, and hard-deny boundaries", () => {
	const workspace = realpathSync(mkdtempSync(join(tmpdir(), "claude-policy-")));
	const protectedDir = join(workspace, "data");
	const envFile = join(workspace, ".env");
	try {
		const opts = {
			workspace,
			protectedPaths: [protectedDir, envFile],
			readOnly: false,
		};
		expect(
			evaluateOrdinaryToolAuthorization(
				"Read",
				{ file_path: join(workspace, "src/index.ts") },
				opts,
			),
		).toBe(true);
		expect(
			evaluateOrdinaryToolAuthorization(
				"Edit",
				{ file_path: join(workspace, "src/index.ts") },
				opts,
			),
		).toBe(true);
		expect(
			evaluateOrdinaryToolAuthorization("Read", { file_path: envFile }, opts),
		).toBe(false);
		expect(
			evaluateOrdinaryToolAuthorization(
				"Edit",
				{ file_path: join(workspace, ".git/HEAD") },
				opts,
			),
		).toBe(false);
		expect(
			evaluateOrdinaryToolAuthorization(
				"Read",
				{ file_path: "/etc/hosts" },
				opts,
			),
		).toBe("ask");
		expect(
			evaluateOrdinaryToolAuthorization("Bash", { command: "bun test" }, opts),
		).toBe(true);
		expect(
			evaluateOrdinaryToolAuthorization(
				"Bash",
				{ command: "git commit -m 'test'" },
				opts,
			),
		).toBe("ask");
		expect(
			evaluateOrdinaryToolAuthorization(
				"Bash",
				{ command: "git push origin main" },
				opts,
			),
		).toBe(false);
		expect(
			evaluateOrdinaryToolAuthorization(
				"Edit",
				{ file_path: join(workspace, "src/index.ts") },
				{ ...opts, readOnly: true },
			),
		).toBe(false);
	} finally {
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("permission approval parser rejects denials and accepts explicit approvals", () => {
	expect(isPermissionApproved("許可する")).toBe(true);
	expect(isPermissionApproved("はい、実行してください")).toBe(true);
	expect(isPermissionApproved("allow")).toBe(true);
	expect(isPermissionApproved("拒否する")).toBe(false);
	expect(isPermissionApproved("許可しない")).toBe(false);
	expect(isPermissionApproved("no, deny")).toBe(false);
	expect(isPermissionApproved("")).toBe(false);
	expect(isPermissionApproved(null)).toBe(false);
});

test("runClaudeExecution handles multi-question multiSelect AskUserQuestion, tool permissions, and failure details", async () => {
	const workspace = realpathSync(mkdtempSync(join(tmpdir(), "claude-engine-")));
	const asked: Array<{ kind?: string; prompt: string; multiSelect?: boolean }> =
		[];
	const evidences: string[] = [];
	const toolActivities: string[] = [];
	try {
		const fakeOpen = ((params: { options?: Options }) => {
			const opts = params.options!;
			const stream = (async function* (): AsyncGenerator<SDKMessage> {
				yield {
					type: "system",
					subtype: "init",
					session_id: "session-1",
				} as SDKMessage;

				// 1. PreToolUse returns "ask" for git commit
				const preHook = opts.hooks?.PreToolUse?.[0]?.hooks?.[0];
				const preDecision = await preHook?.(
					{
						hook_event_name: "PreToolUse",
						tool_name: "Bash",
						tool_input: { command: "git commit -m 'x'" },
						tool_use_id: "tu-1",
					} as never,
					"tu-1",
					{ signal: new AbortController().signal },
				);
				expect(
					(
						preDecision as {
							hookSpecificOutput?: { permissionDecision?: string };
						}
					)?.hookSpecificOutput?.permissionDecision,
				).toBe("ask");

				// 2. canUseTool handles permission prompt
				const permResult = await opts.canUseTool!(
					"Bash",
					{ command: "git commit -m 'x'" },
					{
						signal: new AbortController().signal,
						decisionReason: "git commit requires confirmation",
						toolUseID: "tu-1",
						requestId: "req-1",
					},
				);
				expect(permResult).toMatchObject({ behavior: "allow" });

				// 3. canUseTool handles multi-question + multiSelect AskUserQuestion
				const askResult = await opts.canUseTool!(
					"AskUserQuestion",
					{
						questions: [
							{
								question: "Which components should be updated?",
								header: "Target",
								options: [{ label: "API" }, { label: "Web" }],
								multiSelect: true,
							},
							{
								question: "Should we keep backward compatibility?",
								options: [{ label: "Yes" }, { label: "No" }],
							},
						],
					},
					{
						signal: new AbortController().signal,
						toolUseID: "tu-2",
						requestId: "req-2",
					},
				);
				expect(askResult).toEqual({
					behavior: "allow",
					updatedInput: {
						questions: [
							{
								question: "Which components should be updated?",
								header: "Target",
								options: [{ label: "API" }, { label: "Web" }],
								multiSelect: true,
							},
							{
								question: "Should we keep backward compatibility?",
								options: [{ label: "Yes" }, { label: "No" }],
							},
						],
						answers: {
							"Which components should be updated?": "API, Web",
							"Should we keep backward compatibility?": "Yes",
						},
					},
				});

				// 4. PostToolUseFailure is recorded in ordinary mode
				const failHook = opts.hooks?.PostToolUseFailure?.[0]?.hooks?.[0];
				await failHook?.(
					{
						hook_event_name: "PostToolUseFailure",
						tool_name: "Bash",
						tool_input: { command: "bun test" },
						tool_use_id: "tu-3",
						error: "Exit code 1: 2 tests failed",
					} as never,
					"tu-3",
					{ signal: new AbortController().signal },
				);

				// 5. stderr is captured and error_max_turns detail is surfaced
				opts.stderr?.("stderr line: warning from test\n");
				yield {
					type: "result",
					subtype: "error_max_turns",
					is_error: true,
					num_turns: 30,
					errors: ["Reached max turns while fixing tests"],
				} as unknown as SDKMessage;
			})();
			return Object.assign(stream, {
				accountInfo: async () => ({ email: "test@example.com" }),
				close: () => {},
			}) as unknown as Query;
		}) as never;

		const replies = ["許可する", "API, Web", "Yes"];
		let idx = 0;
		const outcome = await runClaudeExecution(
			{
				cwd: workspace,
				executable: "claude",
				env: {},
				instruction: "Fix tests",
				projectInstructions: "",
				deadline: Date.now() + 60_000,
				maxTurns: 30,
				tools: ["Read", "Edit", "Bash"],
				authorize: (tool, raw) =>
					evaluateOrdinaryToolAuthorization(tool, raw, {
						workspace,
						protectedPaths: [],
						readOnly: false,
					}),
				validateAccount: () => true,
				onSession: () => {},
				onToolActivity: (tool) => toolActivities.push(tool),
				onEvidence: (_ref, text) => evidences.push(text),
				ask: async (q) => {
					asked.push({
						kind: q.kind,
						prompt: q.prompt,
						multiSelect: q.multiSelect,
					});
					return replies[idx++] ?? null;
				},
			},
			new AbortController().signal,
			fakeOpen,
		);

		expect(asked).toHaveLength(3);
		expect(asked[0]?.kind).toBe("permission");
		expect(asked[1]?.kind).toBe("question");
		expect(asked[1]?.multiSelect).toBe(true);
		expect(asked[1]?.prompt).toContain("[1/2]");
		expect(asked[2]?.prompt).toContain("[2/2]");
		expect(toolActivities).toEqual(["Bash"]);
		expect(evidences).toHaveLength(1);
		expect(evidences[0]).toContain("Exit code 1: 2 tests failed");
		expect(outcome.result).toEqual({
			text: "",
			turns: 30,
			ok: false,
			subtype: "error_max_turns",
			errorDetail: "Reached max turns while fixing tests",
		});
		expect(outcome.stderrExcerpt).toContain("stderr line: warning from test");
	} finally {
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("claudeRunnerClient fetches detailed events and ClaudeService propagates failure and progress fields", async () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "claude-events-")));
	const id = crypto.randomUUID();
	const deadline = Date.now() + 10_000;
	const spec: ClaudeStart = {
		id,
		workId: crypto.randomUUID(),
		generation: 0,
		instruction: "Inspect and fix",
		priorExecutionId: null,
		deadline,
		maxTurns: 10,
		readOnly: true,
	};
	const service = new ClaudeService(
		root,
		root,
		({ instruction }) => ({
			cwd: root,
			executable: "fixture",
			env: {},
			instruction,
			projectInstructions: "",
			deadline,
			maxTurns: 10,
			tools: ["Read"],
			authorize: () => true,
			validateAccount: () => true,
		}),
		async (input) => {
			input.onSession(crypto.randomUUID());
			input.onToolActivity?.("Read");
			input.onEvidence("1", "First read output");
			input.onEvidence("2", "Second failure detail");
			return {
				result: {
					text: "",
					turns: 10,
					ok: false,
					subtype: "error_max_turns",
					errorDetail: "Turn limit reached",
				},
				stderrExcerpt: "cli stderr detail",
				managedExecutionStopped: true,
				aborted: false,
				evidenceCount: 2,
			};
		},
	);
	try {
		service.request({ operation: "start", spec });
		await Bun.sleep(20);
		const obs = service.request({
			operation: "inspect",
			id,
		}) as ClaudeObservation;
		expect(obs).toMatchObject({
			state: "failed",
			resultSubtype: "error_max_turns",
			errorDetail: "Turn limit reached",
			stderrExcerpt: "cli stderr detail",
			lastTool: "Read",
			eventCount: 2,
		});
		const page = service.request({
			operation: "events",
			id,
			after: 0,
		}) as { events: Array<{ seq: number; text: string }>; next: number };
		expect(page).toEqual({
			events: [
				{ seq: 1, text: "First read output" },
				{ seq: 2, text: "Second failure detail" },
			],
			next: 2,
		});
	} finally {
		await service.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("serveClaudeRunner exposes events over the private unix socket client", async () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "claude-sock-events-")));
	const host = await serveClaudeRunner(root, root, (spec) => ({
		cwd: root,
		executable: "fixture",
		env: {},
		instruction: spec.instruction,
		projectInstructions: "",
		deadline: spec.deadline,
		maxTurns: spec.maxTurns,
		tools: ["Read"],
		authorize: () => true,
		validateAccount: () => true,
	}));
	try {
		const client = claudeRunnerClient(host.socket, root);
		expect(await client.probe()).toBe(true);
		const empty = await client.events(crypto.randomUUID(), 0);
		expect(empty).toEqual({ events: [], next: 0 });
	} finally {
		await host.close();
		rmSync(root, { recursive: true, force: true });
	}
});
