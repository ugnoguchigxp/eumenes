import { expect, test } from "bun:test";
import { Hono } from "hono";
import { registerTerminals } from "../controller";
import { createTerminals } from "../service";
import { childEnv } from "../spawn";
import { fakePty } from "./terminals.fixture";

async function readEvents(response: Response, count: number) {
	const reader = response
		.body!.pipeThrough(new TextDecoderStream())
		.getReader();
	let text = "";
	const events: Array<{ event: string; data: string }> = [];
	while (events.length < count) {
		const { value, done } = await reader.read();
		if (done) break;
		text += value;
		const blocks = text.split("\n\n");
		text = blocks.pop() ?? "";
		for (const block of blocks) {
			const event = /^event: (.+)$/m.exec(block)?.[1];
			const data = /^data: (.*)$/m.exec(block)?.[1];
			if (event && data !== undefined) events.push({ event, data });
		}
	}
	await reader.cancel();
	return events;
}
const decode = (data: string) => Buffer.from(data, "base64").toString();

test("starts sessions up to the limit, forwards input and resize, and reports exit", async () => {
	const pty = fakePty();
	const terminals = createTerminals({
		command: ["claude"],
		spawn: pty.spawn,
		limit: 2,
	});
	expect(terminals.list()).toMatchObject({ available: true, sessions: [] });
	const a = terminals.start({ cols: 80, rows: 24 });
	terminals.start({ title: "右", cols: 80, rows: 24 });
	expect(() => terminals.start({ cols: 80, rows: 24 })).toThrow(
		"terminal_limit_reached",
	);
	expect(terminals.list().sessions.map((s) => s.title)).toEqual([
		"Claude Code 1",
		"右",
	]);

	terminals.input(a.id, "hello\r");
	terminals.resize(a.id, { cols: 100, rows: 30 });
	expect(pty.spawned[0]!.writes).toEqual(["hello\r"]);
	expect(pty.spawned[0]!.sizes).toEqual([
		{ cols: 80, rows: 24 },
		{ cols: 100, rows: 30 },
	]);

	const before = terminals.list().revision;
	pty.spawned[0]!.exit(0);
	await Bun.sleep(0);
	expect(terminals.list().sessions[0]).toMatchObject({
		status: "exited",
		exitCode: 0,
		run: 1,
	});
	expect(terminals.list().revision).toBeGreaterThan(before);
	expect(pty.spawned[0]!.closed).toBe(true);
	expect(() => terminals.input(a.id, "x")).toThrow("terminal_not_running");

	const restarted = terminals.restart(a.id, { cols: 90, rows: 20 });
	expect(restarted).toMatchObject({ status: "running", run: 2 });
	expect(pty.spawned[2]!.sizes).toEqual([{ cols: 90, rows: 20 }]);
	expect(() => terminals.restart(a.id, { cols: 90, rows: 20 })).toThrow(
		"terminal_running",
	);

	expect(() => terminals.input("missing", "x")).toThrow("terminal_not_found");
	terminals.closeAll();
	expect(pty.spawned[1]!.killed).toBe(true);
	expect(pty.spawned[2]!.killed).toBe(true);
	expect(terminals.list().sessions).toEqual([]);
});

test("is unavailable without the command", () => {
	const terminals = createTerminals({ command: null, spawn: fakePty().spawn });
	expect(terminals.available()).toBe(false);
	expect(() => terminals.start({ cols: 80, rows: 24 })).toThrow(
		"terminal_unavailable",
	);
});

test("streams the backlog, live output and the end of the run", async () => {
	const pty = fakePty();
	const terminals = createTerminals({ command: ["claude"], spawn: pty.spawn });
	const session = terminals.start({ cols: 80, rows: 24 });
	pty.spawned[0]!.onData(new TextEncoder().encode("earlier "));
	const response = terminals.stream(session.id, new AbortController().signal);
	expect(response.headers.get("content-type")).toBe("text/event-stream");
	const events = readEvents(response, 3);
	pty.spawned[0]!.onData(new TextEncoder().encode("live"));
	pty.spawned[0]!.exit(0);
	const received = await events;
	expect(received.map((e) => e.event)).toEqual(["output", "output", "exit"]);
	expect(decode(received[0]!.data)).toBe("earlier ");
	expect(decode(received[1]!.data)).toBe("live");

	// A reopened screen of the ended run sees its final output, then the end.
	const replay = await readEvents(
		terminals.stream(session.id, new AbortController().signal),
		2,
	);
	expect(replay.map((e) => e.event)).toEqual(["output", "exit"]);
	expect(decode(replay[0]!.data)).toBe("earlier live");
});

test("keeps only the latest output in the backlog", async () => {
	const pty = fakePty();
	const terminals = createTerminals({
		command: ["claude"],
		spawn: pty.spawn,
		backlogBytes: 4,
	});
	const session = terminals.start({ cols: 80, rows: 24 });
	for (const chunk of ["aa", "bb", "cc"])
		pty.spawned[0]!.onData(new TextEncoder().encode(chunk));
	pty.spawned[0]!.exit(0);
	await Bun.sleep(0);
	const replay = await readEvents(
		terminals.stream(session.id, new AbortController().signal),
		1,
	);
	expect(decode(replay[0]!.data)).toBe("bbcc");
});

test("HTTP routes validate input and map domain errors", async () => {
	const pty = fakePty();
	const terminals = createTerminals({ command: ["claude"], spawn: pty.spawn });
	const app = new Hono();
	registerTerminals(app, terminals);
	app.onError((error, c) => c.json({ error: error.message }, 409));
	const post = (path: string, body: unknown) =>
		app.request(path, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
	expect((await post("/api/terminals", { cols: 1, rows: 24 })).status).toBe(
		400,
	);
	const started = await post("/api/terminals", { cols: 80, rows: 24 });
	expect(started.status).toBe(201);
	const { id } = (await started.json()) as { id: string };
	expect(
		(await post(`/api/terminals/${id}/input`, { data: "ls\r" })).status,
	).toBe(204);
	expect(pty.spawned[0]!.writes).toEqual(["ls\r"]);
	expect(
		(await post("/api/terminals/not-a-uuid/input", { data: "x" })).status,
	).toBe(400);
	expect(await (await app.request("/api/terminals")).json()).toMatchObject({
		sessions: [{ id, status: "running" }],
	});
});

test.skipIf(process.platform === "win32")(
	"runs a real program on Bun's PTY",
	async () => {
		const terminals = createTerminals({
			command: [
				"/bin/sh",
				"-c",
				'printf "ready "; read line; printf "got:$line"',
			],
		});
		const session = terminals.start({ cols: 80, rows: 24 });
		const response = terminals.stream(session.id, new AbortController().signal);
		const reader = response
			.body!.pipeThrough(new TextDecoderStream())
			.getReader();
		let output = "";
		let typed = false;
		const deadline = Date.now() + 5000;
		while (Date.now() < deadline) {
			const { value, done } = await reader.read();
			if (done) break;
			for (const data of value.matchAll(/^data: (.*)$/gm))
				output += data[1] === "{}" ? "" : decode(data[1]!);
			if (!typed && output.includes("ready")) {
				typed = true;
				terminals.input(session.id, "hi\r");
			}
			if (value.includes("event: exit")) break;
		}
		expect(output).toContain("got:hi");
		expect(terminals.list().sessions[0]).toMatchObject({
			status: "exited",
			exitCode: 0,
		});
		terminals.closeAll();
	},
);

test("the child does not inherit Eumenes secrets, server colors or a parent Claude Code session", () => {
	expect(
		childEnv({
			HOME: "/home/a",
			EUMENES_API_TOKEN: "secret",
			EUMENES_KEY_DIR: "/keys",
			NO_COLOR: "1",
			CLAUDECODE: "1",
			CLAUDE_CODE_CHILD_SESSION: "1",
			CLAUDE_CODE_MESSAGING_TOKEN: "parent-secret",
			CLAUDE_CODE_SESSION_ID: "parent",
			CLAUDE_CODE_USE_BEDROCK: "1",
			TERM: "dumb",
		}),
	).toEqual({
		HOME: "/home/a",
		CLAUDE_CODE_USE_BEDROCK: "1",
		TERM: "xterm-256color",
		COLORTERM: "truecolor",
	});
});

test("a failed restart keeps the last output", async () => {
	const pty = fakePty();
	let fail = false;
	const terminals = createTerminals({
		command: ["claude"],
		spawn: (request) => {
			if (fail) throw new Error("spawn_failed");
			return pty.spawn(request);
		},
	});
	const session = terminals.start({ cols: 80, rows: 24 });
	pty.spawned[0]!.onData(new TextEncoder().encode("last words"));
	pty.spawned[0]!.exit(1);
	await Bun.sleep(0);
	fail = true;
	expect(() => terminals.restart(session.id, { cols: 80, rows: 24 })).toThrow(
		"spawn_failed",
	);
	const replay = await readEvents(
		terminals.stream(session.id, new AbortController().signal),
		1,
	);
	expect(decode(replay[0]!.data)).toBe("last words");
});
