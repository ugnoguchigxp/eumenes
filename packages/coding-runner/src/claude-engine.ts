import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
	query,
	type Options,
	type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { processTree } from "./sdk-process-tree";

const questionInput = z.object({
	questions: z
		.array(
			z.object({
				question: z.string().min(1).max(600),
				options: z
					.array(z.object({ label: z.string().min(1).max(200) }))
					.max(8),
				multiSelect: z.boolean().optional(),
			}),
		)
		.length(1),
});

export type ClaudeEngineInput = {
	cwd: string;
	executable: string;
	env: NonNullable<Options["env"]>;
	instruction: string;
	projectInstructions: string;
	sessionId?: string;
	model?: string;
	deadline: number;
	maxTurns: number;
	tools: string[];
	sandbox?: Options["sandbox"];
	authorize(tool: string, input: Record<string, unknown>): boolean;
	validateAccount(
		account: Awaited<ReturnType<ReturnType<typeof query>["accountInfo"]>>,
	): boolean;
	onSession(id: string): void;
	onEvidence(ref: string, observation: string): void;
	ask(
		question: { id: string; prompt: string; expiresAt: number },
		signal: AbortSignal,
	): Promise<string | null>;
};

type ClaudeEngineResult = {
	result?: { text: string; turns: number; ok: boolean };
	managedExecutionStopped: boolean;
	aborted: boolean;
	evidenceCount: number;
};

export async function runClaudeExecution(
	input: ClaudeEngineInput,
	signal: AbortSignal,
	open = query,
): Promise<ClaudeEngineResult> {
	const controller = new AbortController();
	const combined = AbortSignal.any([
		controller.signal,
		signal,
		AbortSignal.timeout(Math.max(1, input.deadline - Date.now())),
	]);
	const abort = () => controller.abort();
	combined.addEventListener("abort", abort, { once: true });
	if (combined.aborted) abort();
	const gate = Promise.withResolvers<boolean>();
	async function* prompt(): AsyncGenerator<SDKUserMessage> {
		if (!(await gate.promise) || combined.aborted) return;
		yield {
			type: "user",
			message: { role: "user", content: input.instruction },
			parent_tool_use_id: null,
		};
	}
	let child: ChildProcessWithoutNullStreams | undefined;
	let tree: ReturnType<typeof processTree> | undefined;
	let processExited = false;
	let observed = 0;
	let evidenceBytes = 0;
	const evidence = (text: string) => {
		const size = Buffer.byteLength(text);
		evidenceBytes += size;
		if (size > 256 * 1024 || evidenceBytes > 64 * 1024 * 1024) {
			abort();
			return;
		}
		input.onEvidence(String(++observed), text);
	};
	const stream = open({
		prompt: prompt(),
		options: {
			cwd: input.cwd,
			env: input.env,
			pathToClaudeCodeExecutable: input.executable,
			abortController: controller,
			strictMcpConfig: true,
			settingSources: [],
			persistSession: true,
			resume: input.sessionId,
			model: input.model,
			maxTurns: input.maxTurns,
			sandbox: input.sandbox,
			systemPrompt: {
				type: "preset",
				preset: "claude_code",
				append: input.projectInstructions,
			},
			tools: [...input.tools, "AskUserQuestion"],
			permissionMode: "default",
			allowedTools: input.tools,
			includePartialMessages: false,
			stderr: () => {},
			spawnClaudeCodeProcess(options) {
				child = spawn(options.command, options.args, {
					cwd: options.cwd,
					env: options.env,
					stdio: "pipe",
				});
				child.once("exit", () => {
					processExited = true;
				});
				child.once("error", () => {});
				if (child.pid) tree = processTree(child.pid, process.pid);
				return child;
			},
			hooks: {
				PreToolUse: [
					{
						hooks: [
							async (hook) => {
								if (hook.hook_event_name !== "PreToolUse") return {};
								if (hook.tool_name === "AskUserQuestion") return {};
								if (
									!combined.aborted &&
									input.tools.includes(hook.tool_name) &&
									input.authorize(
										hook.tool_name,
										hook.tool_input as Record<string, unknown>,
									)
								)
									return {};
								return {
									hookSpecificOutput: {
										hookEventName: "PreToolUse",
										permissionDecision: "deny",
										permissionDecisionReason:
											"Outside the authorized work scope",
									},
								};
							},
						],
					},
				],
				PostToolUse: [
					{
						hooks: [
							async (hook, id) => {
								if (hook.hook_event_name === "PostToolUse")
									evidence(
										JSON.stringify({
											id,
											tool: hook.tool_name,
											input: hook.tool_input,
											result: hook.tool_response,
										}),
									);
								return {};
							},
						],
					},
				],
			},
			canUseTool: async (tool, raw, { signal: requestSignal }) => {
				const data = questionInput.safeParse(raw);
				if (
					tool !== "AskUserQuestion" ||
					!data.success ||
					data.data.questions[0]?.multiSelect ||
					combined.aborted
				)
					return {
						behavior: "deny",
						message: "The requested operation is outside the current contract.",
					};
				const question = data.data.questions[0]!;
				const answer = await input.ask(
					{
						id: crypto.randomUUID(),
						prompt: [
							question.question,
							...question.options.map(({ label }) => label),
						]
							.join("\n")
							.slice(0, 2_000),
						expiresAt: Math.min(input.deadline, Date.now() + 15 * 60_000),
					},
					AbortSignal.any([combined, requestSignal]),
				);
				return answer && !combined.aborted && !requestSignal.aborted
					? {
							behavior: "allow",
							updatedInput: {
								...raw,
								answers: { [question.question]: answer },
							},
						}
					: { behavior: "deny", message: "No current answer was available." };
			},
		},
	});
	const monitor = setInterval(() => tree?.observe(), 200);
	let result: { text: string; turns: number; ok: boolean } | undefined;
	try {
		const account = await Promise.race([
			stream.accountInfo(),
			untilAbort(combined),
		]);
		if (!input.validateAccount(account))
			throw new Error("claude_account_mismatch");
		gate.resolve(true);
		for await (const event of stream) {
			if (event.type === "system" && event.subtype === "init")
				input.onSession(event.session_id);
			if (event.type === "result") {
				const ok = event.subtype === "success" && !event.is_error;
				result = {
					text: ok ? event.result.slice(0, 4_000) : "",
					turns: event.num_turns,
					ok,
				};
				break;
			}
		}
	} catch {
		// Error details from Claude Code may contain tool inputs or credentials.
	} finally {
		gate.resolve(false);
		stream.close();
		clearInterval(monitor);
		combined.removeEventListener("abort", abort);
		if (child && (!processExited || tree?.confirmed() === false)) {
			tree?.kill("SIGTERM");
			await boundedExit(() => processExited);
			if (!processExited || tree?.confirmed() === false) {
				tree?.kill("SIGKILL");
				if (!processExited) child.kill("SIGKILL");
				await boundedExit(() => processExited);
			}
		}
	}
	const managedExecutionStopped =
		!!child && processExited && tree?.confirmed() === true;
	return {
		result,
		managedExecutionStopped,
		aborted: combined.aborted,
		evidenceCount: observed,
	};
}

function untilAbort(signal: AbortSignal): Promise<never> {
	return new Promise((_, reject) => {
		if (signal.aborted) reject(signal.reason);
		else
			signal.addEventListener("abort", () => reject(signal.reason), {
				once: true,
			});
	});
}

async function boundedExit(exited: () => boolean) {
	for (let i = 0; i < 20 && !exited(); i++) await Bun.sleep(50);
}
