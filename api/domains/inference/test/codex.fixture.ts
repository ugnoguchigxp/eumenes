import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCloudAgents } from "../adapters/cloud-agents";
import type { CloudAgentCall } from "../adapters/cloud-agent-shared";
import { createCodexHost, type CodexHost } from "../adapters/codex-host";
import { IDLE_MS } from "../adapters/codex-threads";

/** What the fake app-server does with the next turn. Read again at every `turn/start`. */
export type FakeBehavior = {
	text?: string;
	/** The turn never ends by itself; `turn/interrupt` ends it. */
	hang?: boolean;
	/** `turn/interrupt` is answered but the turn does not end. */
	stuck?: boolean;
	/** The turn ends with this status instead of `completed`. */
	status?: string;
	/** The process exits in the middle of the turn. */
	exit?: boolean;
	/** Counters this turn adds to the thread's cumulative total. */
	input?: number;
	output?: number;
	cached?: number;
	/** The turn reports a finished Web search, of this turn or (`other`) of another. */
	search?: "this" | "other";
	/** The agent message, and each of `deltas` streamed pieces before it, is this many bytes. */
	bytes?: number;
	deltas?: number;
	/** `thread/delete` is answered with an error and leaves its record file. */
	deleteFails?: boolean;
};
export type FakeRequest = {
	pid: number;
	method: string;
	params: Record<string, any>;
};

/**
 * A protocol fixture standing in for `codex app-server`: never an installed Codex process or a real provider.
 * Threads keep a cumulative token total (reset by a revert, like the real one), and every thread has a record
 * file under `CODEX_HOME/sessions` that `thread/delete` removes.
 */
export async function fakeCodex() {
	const dir = await mkdtemp(join(tmpdir(), "fake-codex-"));
	const command = join(dir, "codex");
	const log = join(dir, "requests.jsonl");
	const behavior = join(dir, "behavior.json");
	const home = join(dir, "codex-home");
	await writeFile(behavior, "{}");
	await writeFile(log, "");
	await writeFile(
		command,
		`#!${process.execPath}
import { createInterface } from "node:readline";
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const out = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
const note = (entry) => appendFileSync(${JSON.stringify(log)}, JSON.stringify({ pid: process.pid, ...entry }) + "\\n");
note({ method: "spawn", params: { argv: process.argv.slice(2), home: process.env.CODEX_HOME, cwd: process.cwd(), key: process.env.CODEX_API_KEY ?? null } });
const threads = new Map();
let n = 0;
const running = new Map();
createInterface({ input: process.stdin }).on("line", (line) => {
	const m = JSON.parse(line);
	if (!m.method) return;
	// Read before the request is noted: a test that waits for the note may change the behavior right after it.
	const current = JSON.parse(readFileSync(${JSON.stringify(behavior)}, "utf8"));
	const behave = () => current;
	note({ method: m.method, params: m.params ?? {} });
	const sessions = () => join(process.env.CODEX_HOME, "sessions");
	if (m.method === "initialize") out({ id: m.id, result: {} });
	else if (m.method === "model/list") out({ id: m.id, result: { data: [{ model: "fixture-model", displayName: "fixture", inputModalities: ["text", "image"] }], nextCursor: null } });
	else if (m.method === "thread/start") {
		const id = "thread-" + process.pid + "-" + ++n;
		threads.set(id, { turns: [], total: { input: 0, output: 0, cached: 0 }, ephemeral: m.params.ephemeral !== false });
		mkdirSync(sessions(), { recursive: true });
		writeFileSync(join(sessions(), "rollout-" + id + ".jsonl"), "{}");
		out({ id: m.id, result: { thread: { id } } });
	} else if (m.method === "thread/revert") {
		const t = threads.get(m.params.threadId);
		if (!t || t.ephemeral) out({ id: m.id, error: { code: -1, message: "revert" } });
		else {
			t.turns = [];
			t.total = { input: 0, output: 0, cached: 0 };
			out({ id: m.id, result: { thread: { id: m.params.threadId } } });
		}
	} else if (m.method === "thread/delete") {
		if (behave().deleteFails) out({ id: m.id, error: { code: -1, message: "delete" } });
		else {
			threads.delete(m.params.threadId);
			rmSync(join(sessions(), "rollout-" + m.params.threadId + ".jsonl"), { force: true });
			out({ id: m.id, result: {} });
		}
	} else if (m.method === "turn/interrupt") {
		out({ id: m.id, result: {} });
		const run = running.get(m.params.threadId);
		if (run && !behave().stuck) {
			running.delete(m.params.threadId);
			out({ method: "turn/completed", params: { threadId: m.params.threadId, turn: { id: run, status: "interrupted" } } });
		}
	} else if (m.method === "turn/start") {
		const b = behave();
		const t = threads.get(m.params.threadId);
		const turnId = "turn-" + ++n;
		t.turns.push(turnId);
		out({ id: m.id, result: { turn: { id: turnId } } });
		if (b.exit) process.exit(3);
		if (b.hang) { running.set(m.params.threadId, turnId); return; }
		t.total.input += b.input ?? 100;
		t.total.output += b.output ?? 10;
		t.total.cached += b.cached ?? 0;
		const total = { inputTokens: t.total.input, outputTokens: t.total.output, cachedInputTokens: t.total.cached, cacheWriteInputTokens: 0, reasoningOutputTokens: 0, totalTokens: t.total.input + t.total.output };
		out({ method: "thread/tokenUsage/updated", params: { threadId: m.params.threadId, turnId, tokenUsage: { total, last: total } } });
		if (b.search) out({ method: "item/completed", params: { threadId: m.params.threadId, turnId: b.search === "this" ? turnId : "other", item: { type: "webSearch" } } });
		for (let i = 0; i < (b.deltas ?? 0); i++) out({ method: "item/agentMessage/delta", params: { threadId: m.params.threadId, turnId, itemId: "m", delta: "y".repeat(b.bytes ?? 1) } });
		const text = b.bytes ? "x".repeat(b.bytes) : b.text ?? "answer";
		out({ method: "item/completed", params: { threadId: m.params.threadId, turnId, item: { type: "agentMessage", text } } });
		out({ method: "turn/completed", params: { threadId: m.params.threadId, turn: { id: turnId, status: b.status ?? "completed" } } });
	}
});
`,
		{ mode: 0o700 },
	);
	const hosts: CodexHost[] = [];
	const read = async () =>
		(await readFile(log, "utf8"))
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as FakeRequest);
	return {
		dir,
		home,
		command,
		/** Replaced in one step, so the fixture never reads a half-written file. */
		async behave(value: FakeBehavior) {
			await writeFile(behavior + ".next", JSON.stringify(value));
			await rename(behavior + ".next", behavior);
		},
		requests: read,
		/** Requests of one method, in order. */
		async of(method: string) {
			return (await read()).filter((r) => r.method === method);
		},
		host(
			options: {
				idleMs?: number;
				maxAgeMs?: number;
				environment?: Record<string, string>;
			} = {},
		) {
			const host = createCodexHost(options.environment ?? { PATH: "" }, {
				executable: command,
				home,
				idleMs: options.idleMs ?? IDLE_MS,
				...(options.maxAgeMs === undefined
					? {}
					: { maxAgeMs: options.maxAgeMs }),
			})!;
			hosts.push(host);
			return host;
		},
		agents(host: CodexHost) {
			return createCloudAgents({ PATH: "" }, { codexHost: host });
		},
		async cleanup() {
			await Promise.allSettled(hosts.map((h) => h.close()));
			await rm(dir, { recursive: true, force: true });
		},
	};
}

export const user = (content: string) => ({ role: "user" as const, content });
export const assistant = (content: string) => ({
	role: "assistant" as const,
	content,
});
export const toolResult = (content: string, id = "call_1") => ({
	role: "tool" as const,
	content,
	tool_call_id: id,
});

/** A Codex call with fixed identity (model, instructions, no tools); only the messages change. */
export function codexCall(
	messages: CloudAgentCall["messages"],
	extra: Partial<CloudAgentCall> = {},
): CloudAgentCall {
	return {
		kind: "codex-sdk",
		model: "fixture-model",
		baseUrl: "https://example.test/v1",
		credential: null,
		messages: [{ role: "system", content: "SYSTEM" }, ...messages],
		signal: AbortSignal.timeout(10_000),
		...extra,
	};
}
