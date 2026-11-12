import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { existsSync, lstatSync } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { configureLogging } from "../../../infrastructure/logger";
import { waitFor } from "../../../infrastructure/wait-for";
import { revokeAgentAttempts } from "../service/agent-revoke";
import {
	assistant,
	codexCall,
	fakeCodex,
	toolResult,
	user,
	type FakeRequest,
} from "./codex.fixture";

afterEach(() => configureLogging({ level: "silent" }));
function capture() {
	const lines: string[] = [];
	configureLogging({
		level: "info",
		destination: { write: (line) => void lines.push(line) },
	});
	return (event: string) =>
		lines.map((line) => JSON.parse(line)).filter((e) => e.event === event);
}
const records = async (home: string) =>
	(await readdir(join(home, "sessions"), { recursive: true }).catch(() => []))
		.map(String)
		.filter((name) => name.endsWith(".jsonl"));
const sentText = (turn: FakeRequest) => turn.params.input[0].text as string;

test("a call starts a new thread, appends to one it continues, or reverts one to its head; the mode is logged", async () => {
	const events = capture();
	const codex = await fakeCodex();
	try {
		const agents = codex.agents(codex.host());
		await agents.run(
			codexCall([user("question one")], { attemptId: "attempt-1" }),
		);
		await agents.run(
			codexCall([
				user("question one"),
				assistant("calling a tool"),
				toolResult("tool says"),
			]),
		);
		await agents.run(codexCall([user("question two")]));
		expect(
			events("inference.codex_thread").map((e) => [e.mode, e.count]),
		).toEqual([
			["new", 1],
			["append", 1],
			["reset", 1],
		]);
		expect(events("inference.codex_thread")[0]!.attemptId).toBe("attempt-1");
		const turns = await codex.of("turn/start");
		// One thread throughout; durable, so that it can be reverted.
		expect(new Set(turns.map((t) => t.params.threadId)).size).toBe(1);
		expect(await codex.of("thread/start")).toHaveLength(1);
		const reverts = await codex.of("thread/revert");
		expect(reverts).toHaveLength(1);
		// The head is the whole thread: revert before the first turn of the thread, not of the last call.
		expect(reverts[0]!.params.beforeTurnId).toBe("turn-2");
		// The full format for the first call and after the revert; only what grew, as a turn of a session, for the append.
		expect(sentText(turns[0]!)).toBe("question one");
		expect(sentText(turns[2]!)).toBe("question two");
		expect(sentText(turns[1]!)).toContain("The context of this turn");
		expect(sentText(turns[1]!)).toContain("tool says");
		expect(sentText(turns[1]!)).not.toContain("question one");
		expect(sentText(turns[1]!)).not.toContain("calling a tool");
	} finally {
		await codex.cleanup();
	}
});

test("a call continues a thread only when it begins with what the thread holds, then the model's own message, then more", async () => {
	const events = capture();
	const codex = await fakeCodex();
	try {
		const agents = codex.agents(codex.host());
		const prime = () => agents.run(codexCall([user("question")]));
		const modes = () => events("inference.codex_thread").map((e) => e.mode);
		await prime();
		// A different front.
		await agents.run(
			codexCall([user("another"), assistant("reply"), toolResult("more")]),
		);
		await prime();
		// The next message is not the model's.
		await agents.run(
			codexCall([user("question"), user("again"), toolResult("more")]),
		);
		await prime();
		// Nothing after the model's message: it is the thread's own output, never sent.
		await agents.run(codexCall([user("question"), assistant("reply")]));
		await prime();
		// A different head (the instructions) is a thread of its own.
		await agents.run({
			...codexCall([user("question"), assistant("reply"), toolResult("more")]),
			messages: [
				{ role: "system", content: "OTHER" },
				user("question"),
				assistant("reply"),
				toolResult("more"),
			],
		});
		expect(modes()).toEqual([
			"new",
			"reset",
			"reset",
			"reset",
			"reset",
			"reset",
			"reset",
			"new",
		]);
		expect(await codex.of("thread/start")).toHaveLength(2);
	} finally {
		await codex.cleanup();
	}
});

test("calls that overlap use threads of their own, one turn at a time each", async () => {
	const codex = await fakeCodex();
	try {
		const agents = codex.agents(codex.host());
		const first = new AbortController();
		await codex.behave({ hang: true });
		const running = agents.run(
			codexCall([user("question")], { signal: first.signal }),
		);
		running.catch(() => {});
		await waitFor(async () => (await codex.of("turn/start")).length === 1);
		await codex.behave({});
		await agents.run(codexCall([user("question")]));
		const turns = await codex.of("turn/start");
		expect(turns).toHaveLength(2);
		expect(turns[0]!.params.threadId).not.toBe(turns[1]!.params.threadId);
		expect(await codex.of("thread/start")).toHaveLength(2);
		expect(await codex.of("thread/revert")).toHaveLength(0);
		first.abort();
		await expect(running).rejects.toBeDefined();
	} finally {
		await codex.cleanup();
	}
});

test("a cancelled call interrupts its turn, keeps the thread and has it reverted before the next use", async () => {
	const codex = await fakeCodex();
	try {
		const agents = codex.agents(codex.host());
		const controller = new AbortController();
		await codex.behave({ hang: true });
		const running = agents.run(
			codexCall([user("question")], { signal: controller.signal }),
		);
		running.catch(() => {});
		await waitFor(async () => (await codex.of("turn/start")).length === 1);
		controller.abort(new Error("stopped_by_user"));
		await expect(running).rejects.toThrow("stopped_by_user");
		const [interrupt] = await codex.of("turn/interrupt");
		expect(interrupt!.params).toEqual({
			threadId: (await codex.of("turn/start"))[0]!.params.threadId,
			turnId: "turn-2",
		});
		expect(await codex.of("thread/delete")).toHaveLength(0);
		await codex.behave({});
		// What the interrupted turn left in the thread is not part of any later call.
		await agents.run(
			codexCall([user("question"), assistant("reply"), toolResult("more")]),
		);
		const turns = await codex.of("turn/start");
		expect(turns[1]!.params.threadId).toBe(turns[0]!.params.threadId);
		const [revert] = await codex.of("thread/revert");
		expect(revert!.params).toEqual({
			threadId: turns[0]!.params.threadId,
			beforeTurnId: "turn-2",
		});
		expect(sentText(turns[1]!)).toBe(
			"The conversation so far, oldest first, as JSON. Write only the next assistant turn.\n" +
				JSON.stringify([
					{ role: "user", content: "question" },
					{ role: "assistant", content: "reply" },
					{ role: "tool", content: "more", tool_call_id: "call_1" },
				]),
		);
		expect(await codex.of("thread/start")).toHaveLength(1);
	} finally {
		await codex.cleanup();
	}
});

test("an interrupt that does not finish in 2 seconds, or a failed turn, gives the thread up", async () => {
	const codex = await fakeCodex();
	try {
		const agents = codex.agents(codex.host());
		const controller = new AbortController();
		await codex.behave({ hang: true, stuck: true });
		const running = agents.run(
			codexCall([user("question")], { signal: controller.signal }),
		);
		running.catch(() => {});
		await waitFor(async () => (await codex.of("turn/start")).length === 1);
		const aborted = performance.now();
		controller.abort(new Error("stopped_by_user"));
		await expect(running).rejects.toThrow("stopped_by_user");
		expect(performance.now() - aborted).toBeGreaterThanOrEqual(1900);
		await waitFor(async () => (await codex.of("thread/delete")).length === 1);
		await waitFor(async () => (await records(codex.home)).length === 0);
		await codex.behave({ status: "failed" });
		await expect(agents.run(codexCall([user("question")]))).rejects.toThrow(
			"cloud_agent_codex_turn_failed",
		);
		await waitFor(async () => (await codex.of("thread/delete")).length === 2);
		await codex.behave({});
		await agents.run(codexCall([user("question")]));
		// Both given up: the next call starts a thread again rather than reverting one.
		expect(await codex.of("thread/start")).toHaveLength(3);
		expect(await codex.of("thread/revert")).toHaveLength(0);
		expect(await records(codex.home)).toHaveLength(1);
	} finally {
		await codex.cleanup();
	}
});

test("a thread idle for the limit is deleted and its record file removed", async () => {
	const codex = await fakeCodex();
	try {
		const agents = codex.agents(codex.host({ idleMs: 40 }));
		await agents.run(codexCall([user("question")]));
		expect(await records(codex.home)).toHaveLength(1);
		await waitFor(async () => (await codex.of("thread/delete")).length === 1);
		expect(await records(codex.home)).toEqual([]);
		await agents.run(codexCall([user("question")]));
		expect(await codex.of("thread/start")).toHaveLength(2);
	} finally {
		await codex.cleanup();
	}
});

test("more than 2 idle threads of one head retire the oldest", async () => {
	const codex = await fakeCodex();
	try {
		const agents = codex.agents(codex.host());
		const controllers = [0, 1, 2].map(() => new AbortController());
		await codex.behave({ hang: true });
		const running = controllers.map((c) =>
			agents.run(codexCall([user("question")], { signal: c.signal })),
		);
		for (const r of running) r.catch(() => {});
		await waitFor(async () => (await codex.of("turn/start")).length === 3);
		// Interrupted threads stay (idle); the one that goes idle first is the oldest.
		for (const [i, c] of controllers.entries()) {
			c.abort(new Error("stopped_by_user"));
			await Promise.allSettled([running[i]!]);
		}
		const interrupts = await codex.of("turn/interrupt");
		await waitFor(async () => (await codex.of("thread/delete")).length === 1);
		expect((await codex.of("thread/delete"))[0]!.params.threadId).toBe(
			interrupts[0]!.params.threadId,
		);
		expect(await records(codex.home)).toHaveLength(2);
	} finally {
		await codex.cleanup();
	}
});

test("a 33rd thread retires the oldest idle one", async () => {
	const codex = await fakeCodex();
	try {
		const agents = codex.agents(codex.host());
		for (let i = 0; i < 33; i++)
			await agents.run({
				...codexCall([user("question")]),
				messages: [{ role: "system", content: `HEAD ${i}` }, user("question")],
			});
		await waitFor(async () => (await codex.of("thread/delete")).length === 1);
		const first = (await codex.of("turn/start"))[0]!.params.threadId;
		expect((await codex.of("thread/delete"))[0]!.params.threadId).toBe(first);
		expect(await records(codex.home)).toHaveLength(32);
	} finally {
		await codex.cleanup();
	}
});

test("a thread whose process refuses to delete it loses its record file anyway", async () => {
	const codex = await fakeCodex();
	try {
		const agents = codex.agents(codex.host({ idleMs: 40 }));
		await codex.behave({ deleteFails: true });
		await agents.run(codexCall([user("question")]));
		await waitFor(async () => (await codex.of("thread/delete")).length === 1);
		await waitFor(async () => (await records(codex.home)).length === 0);
	} finally {
		await codex.cleanup();
	}
});

test("usage is what the turn added to the thread total; a reverted thread counts from zero", async () => {
	const codex = await fakeCodex();
	try {
		const agents = codex.agents(codex.host());
		const usage = (r: {
			inputTokens?: number | null;
			cacheReadTokens?: number | null;
			outputTokens?: number | null;
		}) => [r.inputTokens, r.cacheReadTokens, r.outputTokens];
		await codex.behave({ input: 1000, cached: 0, output: 10 });
		expect(usage(await agents.run(codexCall([user("question")])))).toEqual([
			1000, 0, 10,
		]);
		await codex.behave({ input: 1100, cached: 900, output: 20 });
		const observed: Array<number | null> = [];
		expect(
			usage(
				await agents.run(
					codexCall([user("question"), assistant("r"), toolResult("more")], {
						onUsage: (u) => observed.push(u.inputTokens),
					}),
				),
			),
		).toEqual([1100, 900, 20]);
		expect(observed).toEqual([1100]);
		await codex.behave({ input: 70, cached: 0, output: 5 });
		expect(usage(await agents.run(codexCall([user("elsewhere")])))).toEqual([
			70, 0, 5,
		]);
		expect((await codex.of("thread/revert")).length).toBe(1);
	} finally {
		await codex.cleanup();
	}
});

test("forgetting deletes idle threads at once, lets a running turn end, then stops the processes and empties the home", async () => {
	const codex = await fakeCodex();
	try {
		const agents = codex.agents(codex.host());
		await agents.run(codexCall([user("one")]));
		const controller = new AbortController();
		await codex.behave({ hang: true });
		const running = agents.run({
			...codexCall([user("two")], { signal: controller.signal }),
			messages: [{ role: "system", content: "OTHER" }, user("two")],
		});
		running.catch(() => {});
		await waitFor(async () => (await codex.of("turn/start")).length === 2);
		// Something Codex itself keeps beside the thread records.
		await writeFile(join(codex.home, "kept-by-codex.sqlite"), "text");
		agents.forget!();
		// The idle thread goes; the running turn is not failed and not left without its notifications.
		await waitFor(async () => (await codex.of("thread/delete")).length === 1);
		let settled = false;
		void running.then(
			() => (settled = true),
			() => (settled = true),
		);
		// A call made meanwhile waits for the home to be emptied.
		const waiting = agents.run(codexCall([user("three")]));
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(settled).toBe(false);
		expect(await codex.of("turn/start")).toHaveLength(2);
		await codex.behave({});
		const aborted = performance.now();
		controller.abort(new Error("stopped_by_user"));
		await expect(running).rejects.toThrow("stopped_by_user");
		// The turn still heard its end: it did not wait out the interrupt limit.
		expect(performance.now() - aborted).toBeLessThan(1500);
		await waiting;
		const spawns = await codex.of("spawn");
		expect(spawns).toHaveLength(2);
		// The waiting call ran in the new process, in a home that holds its thread only.
		const turns = await codex.of("turn/start");
		expect(turns[2]!.pid).toBe(spawns[1]!.pid);
		expect(existsSync(join(codex.home, "kept-by-codex.sqlite"))).toBe(false);
		expect(await records(codex.home)).toHaveLength(1);
	} finally {
		await codex.cleanup();
	}
});

test("a thread whose answer asked for a function is left for the call that continues it; two that hold the same front are not appended to", async () => {
	const events = capture();
	const codex = await fakeCodex();
	try {
		const agents = codex.agents(codex.host());
		const tools = [
			{
				type: "function" as const,
				function: { name: "look", description: "", parameters: {} },
			},
		];
		const modes = () => events("inference.codex_thread").map((e) => e.mode);
		await codex.behave({
			text: JSON.stringify({
				reply: null,
				tool: { name: "look", arguments: "{}" },
			}),
		});
		await agents.run(codexCall([user("one")], { tools }));
		// Another conversation does not take the thread that waits for its function result.
		await agents.run(codexCall([user("other")], { tools }));
		await codex.behave({ text: JSON.stringify({ reply: "done", tool: null }) });
		await agents.run(
			codexCall([user("one"), assistant(""), toolResult("found")], { tools }),
		);
		expect(modes()).toEqual(["new", "new", "append"]);
		// The first thread's answer asked for nothing more: the next call reverts that one, not the one still waiting.
		await agents.run(codexCall([user("third")], { tools }));
		expect(modes()).toEqual(["new", "new", "append", "reset"]);
		const turns = await codex.of("turn/start");
		expect(turns[3]!.params.threadId).toBe(turns[0]!.params.threadId);
	} finally {
		await codex.cleanup();
	}
});

test("a thread older than the limit is deleted when its turn ends", async () => {
	const events = capture();
	const codex = await fakeCodex();
	try {
		const agents = codex.agents(codex.host({ maxAgeMs: 0 }));
		await agents.run(codexCall([user("question")]));
		await waitFor(async () => (await codex.of("thread/delete")).length === 1);
		await agents.run(codexCall([user("question")]));
		expect(events("inference.codex_thread").map((e) => e.mode)).toEqual([
			"new",
			"new",
		]);
	} finally {
		await codex.cleanup();
	}
});

test("revoking attempts that stood on a forgotten reference makes the agents forget their threads", () => {
	const db = new Database(":memory:");
	db.exec(`CREATE TABLE inference_requests (id TEXT, status TEXT);
		CREATE TABLE inference_attempts (id TEXT, request_id TEXT, refs TEXT, accepted INT, status TEXT, reason TEXT, ended INT);`);
	let forgotten = 0;
	revokeAgentAttempts(db, { messageIds: [], itemIds: [] }, () => forgotten++);
	expect(forgotten).toBe(0);
	revokeAgentAttempts(
		db,
		{ messageIds: ["m"], itemIds: [] },
		() => forgotten++,
	);
	expect(forgotten).toBe(1);
});

test("a process that exits is replaced by the next call, which starts a new thread", async () => {
	const events = capture();
	const codex = await fakeCodex();
	try {
		const agents = codex.agents(codex.host());
		await agents.run(codexCall([user("question")]));
		await codex.behave({ exit: true });
		await expect(agents.run(codexCall([user("again")]))).rejects.toThrow(
			"cloud_agent_incomplete_turn",
		);
		await codex.behave({});
		await agents.run(codexCall([user("question")]));
		const spawns = await codex.of("spawn");
		expect(spawns).toHaveLength(2);
		expect(spawns[0]!.pid).not.toBe(spawns[1]!.pid);
		expect(await codex.of("thread/start")).toHaveLength(2);
		// The one revert was in the process that is gone; the new process starts clean.
		expect((await codex.of("thread/revert")).map((r) => r.pid)).toEqual([
			spawns[0]!.pid,
		]);
		const process = events("inference.codex_process");
		expect(process.map((e) => e.outcome)).toEqual([
			"started",
			"exited",
			"started",
		]);
		expect(process[1]!.exitCode).toBe(3);
		// Nothing is left of the threads of the process that is gone.
		expect(await records(codex.home)).toHaveLength(1);
	} finally {
		await codex.cleanup();
	}
});

test("the output limit is a turn's, not the process's", async () => {
	const codex = await fakeCodex();
	try {
		const agents = codex.agents(codex.host());
		// 12 streamed pieces and the message: below 4 MiB for one turn, but two turns are over it in all.
		await codex.behave({ deltas: 12, bytes: 250_000 });
		for (let i = 0; i < 3; i++)
			expect(
				(await agents.run(codexCall([user(`question ${i}`)]))).text,
			).toHaveLength(250_000);
		await codex.behave({ deltas: 20, bytes: 250_000 });
		await expect(agents.run(codexCall([user("question")]))).rejects.toThrow(
			"cloud_agent_output_limit",
		);
		await codex.behave({});
		expect((await agents.run(codexCall([user("question")]))).text).toBe(
			"answer",
		);
		// One process throughout.
		expect(await codex.of("spawn")).toHaveLength(1);
	} finally {
		await codex.cleanup();
	}
});

test("calls share a process by login and Web search; model discovery shares it too", async () => {
	const codex = await fakeCodex();
	try {
		const host = codex.host();
		const agents = codex.agents(host);
		await codex.behave({ search: "this" });
		await agents.run(codexCall([user("a")]));
		await host.models(
			{ credential: null, baseUrl: "https://example.test/v1" },
			AbortSignal.timeout(5000),
		);
		await agents.run(codexCall([user("b")], { nativeWebSearch: true }));
		await agents.run(
			codexCall([user("c")], {
				credential: "key-1",
				baseUrl: "https://host.test/v1",
			}),
		);
		await agents.run(
			codexCall([user("d")], {
				credential: "key-1",
				baseUrl: "https://host.test/v1",
			}),
		);
		const spawns = await codex.of("spawn");
		expect(spawns.map((s) => s.params.key)).toEqual([null, null, "key-1"]);
		expect(spawns[2]!.params.argv).toContain(
			'openai_base_url="https://host.test/v1"',
		);
		expect(spawns[0]!.params.argv.join(" ")).not.toContain("openai_base_url");
		expect(await codex.of("model/list")).toHaveLength(1);
	} finally {
		await codex.cleanup();
	}
});

test("the Codex home is emptied before the first process, and a CLI login is linked, not copied", async () => {
	const codex = await fakeCodex();
	try {
		const personal = join(codex.dir, "personal");
		await mkdir(personal);
		await writeFile(join(personal, "auth.json"), '{"login":true}');
		await mkdir(codex.home, { recursive: true });
		await writeFile(join(codex.home, "stale.txt"), "left by an earlier run");
		const agents = codex.agents(
			codex.host({ environment: { PATH: "", CODEX_HOME: personal } }),
		);
		expect(existsSync(join(codex.home, "stale.txt"))).toBe(true);
		await agents.run(codexCall([user("question")]));
		expect(existsSync(join(codex.home, "stale.txt"))).toBe(false);
		expect(lstatSync(join(codex.home, "auth.json")).isSymbolicLink()).toBe(
			true,
		);
		const [spawn] = await codex.of("spawn");
		expect(spawn!.params.home).toBe(codex.home);
	} finally {
		await codex.cleanup();
	}
});
