import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { disabledFeatures, type CodexRuntime } from "./codex-sdk";
import { codexUsage, type CodexUsage } from "./codex-usage";

/** One conversation turn over `codex app-server` (stdio JSON-RPC), which streams
 * agent message deltas that `codex exec --json` only reports when complete. */
export type CodexTurn = {
	cwd: string;
	model: string;
	instructions: string;
	prompt: string;
	outputSchema?: unknown;
	reasoningEffort?: "low" | "medium" | "high";
	signal: AbortSignal;
	/** The current agent message so far (cumulative), on every delta. */
	onMessage?: (text: string) => void;
	onUsage?: (usage: CodexUsage) => void;
};
export type CodexTurnResult = CodexUsage & {
	text: string;
	inputTokens: number | null;
	outputTokens: number | null;
};

const lineLimit = 1 << 20;
const outputLimit = 4 << 20;

/** Process-level isolation equivalent to the SDK client: no native tools, plugins,
 * MCP servers, web search, project docs or history. */
function configArgs() {
	const overrides: string[] = [
		...Object.keys(disabledFeatures).map((name) => `features.${name}=false`),
		"features.skip_host_skill_discovery=true",
		"project_doc_max_bytes=0",
		'history.persistence="none"',
		"mcp_servers={}",
		// The conversation never searches by itself; Eumenes owns web access.
		'web_search="disabled"',
	];
	return overrides.flatMap((o) => ["-c", o]);
}

export async function runCodexTurn(
	runtime: CodexRuntime,
	turn: CodexTurn,
	fail: (reason: string) => Error,
): Promise<CodexTurnResult> {
	turn.signal.throwIfAborted();
	const child = spawn(
		runtime.command,
		["app-server", ...configArgs(), ...(runtime.extraArgs ?? [])],
		{
			cwd: turn.cwd,
			env: runtime.env,
			detached: true,
			stdio: ["pipe", "pipe", "pipe"],
		},
	);
	let exited = false;
	const kill = (signal: NodeJS.Signals) => {
		if (exited || !child.pid) return;
		try {
			process.kill(-child.pid, signal);
		} catch {
			try {
				child.kill(signal);
			} catch {
				/* already gone */
			}
		}
	};
	// Stays attached for the child's whole life: an unhandled "error" would crash the host.
	child.on("error", () => {});
	child.stdin.on("error", () => {});
	child.stderr.resume();

	let nextId = 1;
	const pending = new Map<
		number,
		{
			method: string;
			resolve: (value: unknown) => void;
			reject: (error: Error) => void;
		}
	>();
	let settle!: {
		resolve: (value: CodexTurnResult) => void;
		reject: (error: Error) => void;
	};
	const done = new Promise<CodexTurnResult>((resolve, reject) => {
		settle = { resolve, reject };
	});
	let finished = false;
	const finish = (error: Error | null, value?: CodexTurnResult) => {
		if (finished) return;
		finished = true;
		for (const p of pending.values())
			p.reject(error ?? fail("incomplete_turn"));
		pending.clear();
		if (error) settle.reject(error);
		else settle.resolve(value!);
	};
	child.on("exit", () => {
		exited = true;
		finish(fail("incomplete_turn"));
	});
	const send = (message: Record<string, unknown>) => {
		if (!child.stdin.writable) return;
		child.stdin.write(JSON.stringify(message) + "\n");
	};
	const request = (method: string, params: unknown) => {
		const id = nextId++;
		send({ id, method, params });
		return new Promise<unknown>((resolve, reject) =>
			pending.set(id, { method, resolve, reject }),
		);
	};

	let threadId: string | undefined;
	let turnId: string | undefined;
	let messageId: string | undefined;
	let message = "";
	let final = "";
	let usage: CodexUsage | null = null;
	let usageModel: string | null = turn.model;
	let received = 0;

	const onLine = (line: string) => {
		received += line.length;
		if (line.length > lineLimit || received > outputLimit)
			return finish(fail("output_limit"));
		let value: Record<string, unknown>;
		try {
			value = JSON.parse(line);
		} catch {
			return;
		}
		if (typeof value.id === "number" && !("method" in value)) {
			const p = pending.get(value.id);
			if (!p) return;
			pending.delete(value.id);
			if (p.method === "turn/start" && !value.error)
				turnId = (value.result as { turn?: { id?: string } })?.turn?.id;
			if (value.error) p.reject(fail("codex_turn_failed"));
			else p.resolve(value.result);
			return;
		}
		const method = value.method;
		const params = (value.params ?? {}) as Record<string, unknown>;
		if ("id" in value && typeof method === "string") {
			// Approvals and other server requests are never granted.
			send({
				id: value.id,
				error: { code: -32601, message: "unsupported by Eumenes" },
			});
			return;
		}
		if (params.threadId !== undefined && params.threadId !== threadId) return;
		if (params.turnId !== undefined && turnId && params.turnId !== turnId)
			return;
		if (method === "item/agentMessage/delta") {
			if (params.itemId !== messageId) {
				messageId = params.itemId as string;
				message = "";
			}
			message += String(params.delta ?? "");
			turn.onMessage?.(message);
		} else if (method === "item/completed") {
			const item = params.item as { type?: string; text?: unknown };
			if (item?.type === "agentMessage" && typeof item.text === "string")
				final = item.text;
		} else if (method === "thread/tokenUsage/updated") {
			if (
				!threadId ||
				params.threadId !== threadId ||
				!turnId ||
				params.turnId !== turnId
			)
				return;
			const next = codexUsage(params.tokenUsage, usageModel);
			if (
				next &&
				(!usage ||
					(next.inputTokens! >= usage.inputTokens! &&
						next.outputTokens! >= usage.outputTokens!))
			) {
				usage = next;
				turn.onUsage?.(next);
			}
		} else if (method === "model/rerouted") {
			if (
				!threadId ||
				params.threadId !== threadId ||
				!turnId ||
				params.turnId !== turnId
			)
				return;
			// Cumulative totals cannot be split between the old and new models.
			usageModel = null;
			if (usage) {
				usage = { ...usage, usageModel: null };
				turn.onUsage?.(usage);
			}
		} else if (method === "turn/completed") {
			const t = params.turn as { id?: string; status?: string };
			if (turnId && t?.id !== turnId) return;
			if (t?.status === "completed")
				finish(null, {
					text: final,
					inputTokens: usage?.inputTokens ?? null,
					outputTokens: usage?.outputTokens ?? null,
					cacheReadTokens: usage?.cacheReadTokens ?? null,
					cacheCreationTokens: usage?.cacheCreationTokens ?? null,
					reasoningTokens: usage?.reasoningTokens ?? null,
					usageModel,
				});
			else finish(fail("codex_turn_failed"));
		}
	};
	const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
	lines.on("line", onLine);
	const onAbort = () => finish(turn.signal.reason ?? fail("cancelled"));
	turn.signal.addEventListener("abort", onAbort, { once: true });

	try {
		await request("initialize", {
			clientInfo: { name: "eumenes", title: "Eumenes", version: "1" },
			capabilities: null,
		});
		send({ method: "initialized" });
		const started = (await request("thread/start", {
			model: turn.model,
			cwd: turn.cwd,
			approvalPolicy: "never",
			sandbox: "read-only",
			baseInstructions: turn.instructions,
			ephemeral: true,
		})) as { thread?: { id?: string } };
		threadId = started?.thread?.id;
		if (!threadId) throw fail("codex_turn_failed");
		const begun = (await request("turn/start", {
			threadId,
			input: [{ type: "text", text: turn.prompt, text_elements: [] }],
			...(turn.outputSchema ? { outputSchema: turn.outputSchema } : {}),
			...(turn.reasoningEffort ? { effort: turn.reasoningEffort } : {}),
		})) as { turn?: { id?: string } };
		turnId = begun?.turn?.id;
		return await done;
	} catch (error) {
		finish(error instanceof Error ? error : fail("codex_turn_failed"));
		throw error;
	} finally {
		turn.signal.removeEventListener("abort", onAbort);
		lines.close();
		child.stdin.end();
		kill("SIGTERM");
		const timer = setTimeout(() => kill("SIGKILL"), 1000);
		timer.unref?.();
		done.catch(() => {});
	}
}
