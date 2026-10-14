import { expect, test } from "bun:test";
import { Hono } from "hono";
import { registerTerminals } from "../controller";
import {
	childEnv,
	createTerminals,
	type SpawnPty,
	type TaskFinished,
} from "../service";

function fakePty() {
	const spawned: Array<{
		onData(bytes: Uint8Array): void;
		command: readonly string[];
		writes: string[];
		sizes: Array<{ cols: number; rows: number }>;
		killed: boolean;
		closed: boolean;
		exit(code: number | null): void;
	}> = [];
	const spawn: SpawnPty = ({ command, size, onData }) => {
		let exit!: (code: number | null) => void;
		const exited = new Promise<number | null>((resolve) => {
			exit = resolve;
		});
		const pty = {
			onData,
			command,
			writes: [] as string[],
			sizes: [size],
			killed: false,
			closed: false,
			exit,
		};
		spawned.push(pty);
		return {
			write: (data) => pty.writes.push(data),
			resize: (next) => pty.sizes.push(next),
			kill: () => {
				pty.killed = true;
				exit(null);
			},
			close: () => {
				pty.closed = true;
			},
			exited,
		};
	};
	return { spawn, spawned };
}

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

test("a request opens Claude Code with the prompt, then types into the running session", async () => {
	const pty = fakePty();
	const terminals = createTerminals({
		command: ["claude"],
		spawn: pty.spawn,
		submitDelayMs: 0,
	});
	const first = terminals.request({
		prompt: "README を直して",
		task: "README 修正",
	});
	expect(first).toMatchObject({
		started: true,
		session: { status: "running", run: 1 },
	});
	expect(pty.spawned[0]!.command).toEqual(["claude", "README を直して"]);
	expect(pty.spawned[0]!.sizes).toEqual([{ cols: 120, rows: 32 }]);

	terminals.resize(first.session.id, { cols: 100, rows: 40 });
	const second = terminals.request({
		prompt: "1行目\n2行目",
		task: "2行の依頼",
	});
	expect(second).toMatchObject({
		started: false,
		session: { id: first.session.id },
	});
	await Bun.sleep(5);
	expect(pty.spawned[0]!.writes).toEqual([
		"\x1b[200~1行目\n2行目\x1b[201~",
		"\r",
	]);

	// The ended session is restarted at its last size, keeping one pane.
	pty.spawned[0]!.exit(0);
	await Bun.sleep(0);
	const third = terminals.request({
		prompt: "-v を調べて",
		task: "オプション調査",
	});
	expect(third).toMatchObject({
		started: true,
		session: { id: first.session.id, run: 2 },
	});
	expect(pty.spawned[1]!.command).toEqual(["claude", " -v を調べて"]);
	expect(pty.spawned[1]!.sizes).toEqual([{ cols: 100, rows: 40 }]);

	const other = terminals.request({
		prompt: "別件",
		task: "別件",
		session: "new",
	});
	expect(other.session.id).not.toBe(first.session.id);
	expect(terminals.list().sessions).toHaveLength(2);
	terminals.closeAll();
});

test("Enter is not pressed into a run that ended before it", async () => {
	const pty = fakePty();
	const terminals = createTerminals({
		command: ["claude"],
		spawn: pty.spawn,
		submitDelayMs: 5,
	});
	terminals.start({ cols: 80, rows: 24 });
	terminals.request({ prompt: "x", task: "x" });
	pty.spawned[0]!.exit(0);
	await Bun.sleep(20);
	expect(pty.spawned[0]!.writes).toEqual(["\x1b[200~x\x1b[201~"]);
});

test("hooks report activity and finish the conversation's task with Claude Code's last answer", async () => {
	const pty = fakePty();
	const changes: number[] = [];
	const terminals = createTerminals({
		command: ["claude"],
		spawn: pty.spawn,
		hookBaseUrl: "http://127.0.0.1:8787",
		onChange: () => changes.push(Date.now()),
	});
	const finished: TaskFinished[] = [];
	terminals.onTaskFinished((event) => finished.push(event));
	const handed = terminals.request({
		prompt: "README を直して",
		task: "README 修正",
		conversationId: "main",
	});
	const command = pty.spawned[0]!.command;
	expect(command[0]).toBe("claude");
	expect(command[1]).toBe("--settings");
	expect(command.at(-1)).toBe("README を直して");
	const settings = JSON.parse(command[2]!) as {
		hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
	};
	expect(Object.keys(settings.hooks).sort()).toEqual([
		"Notification",
		"Stop",
		"UserPromptSubmit",
	]);
	const hookCommand = settings.hooks.Stop![0]!.hooks[0]!.command;
	expect(hookCommand).toContain(
		`http://127.0.0.1:8787/hooks/terminals/${handed.session.id}`,
	);
	expect(hookCommand).not.toContain("README");
	const token = /x-eumenes-hook-token: ([0-9a-f]{64})/.exec(hookCommand)![1]!;
	expect(terminals.list().sessions[0]).toMatchObject({
		activity: "working",
		task: "README 修正",
	});

	expect(() =>
		terminals.hook(handed.session.id, "0".repeat(64), {
			hook_event_name: "Stop",
		}),
	).toThrow("terminal_hook_forbidden");
	terminals.hook(handed.session.id, token, { hook_event_name: "Notification" });
	expect(terminals.list().sessions[0]!.activity).toBe("waiting");
	expect(finished).toEqual([]);

	terminals.hook(handed.session.id, token, {
		hook_event_name: "Stop",
		last_assistant_message: "README を更新しました。",
	});
	expect(finished).toEqual([
		{
			sessionId: handed.session.id,
			run: 1,
			task: "README 修正",
			conversationId: "main",
			lastMessage: "README を更新しました。",
		},
	]);
	expect(terminals.list().sessions[0]).toMatchObject({ activity: "idle" });
	expect(terminals.list().sessions[0]!.task).toBeUndefined();
	expect(changes.length).toBeGreaterThanOrEqual(4);

	// Work typed directly in the screen has no task: activity only, no report.
	terminals.hook(handed.session.id, token, {
		hook_event_name: "UserPromptSubmit",
	});
	terminals.hook(handed.session.id, token, { hook_event_name: "Stop" });
	expect(finished).toHaveLength(1);

	// A restarted run gets a new token; the old one no longer reports.
	pty.spawned[0]!.exit(0);
	await Bun.sleep(0);
	expect(() =>
		terminals.hook(handed.session.id, token, { hook_event_name: "Stop" }),
	).toThrow("terminal_hook_forbidden");
	terminals.closeAll();
});

test("the hook route needs the run's token and ignores unknown events", async () => {
	const pty = fakePty();
	const terminals = createTerminals({
		command: ["claude"],
		spawn: pty.spawn,
		hookBaseUrl: "http://127.0.0.1:8787",
	});
	const app = new Hono();
	registerTerminals(app, terminals);
	app.onError((error, c) =>
		c.json(
			{ error: error.message },
			error.message === "terminal_hook_forbidden" ? 403 : 500,
		),
	);
	const session = terminals.request({
		prompt: "x",
		task: "x",
		conversationId: "main",
	}).session;
	const token = /x-eumenes-hook-token: ([0-9a-f]{64})/.exec(
		pty.spawned[0]!.command[2]!,
	)![1]!;
	const post = (body: unknown, headers: Record<string, string> = {}) =>
		app.request(`/hooks/terminals/${session.id}`, {
			method: "POST",
			headers: { "content-type": "application/json", ...headers },
			body: JSON.stringify(body),
		});
	expect((await post({ hook_event_name: "Stop" })).status).toBe(403);
	expect(
		(await post({ hook_event_name: "Stop" }, { "x-eumenes-hook-token": "bad" }))
			.status,
	).toBe(403);
	expect(
		(
			await post(
				{ hook_event_name: "PreToolUse" },
				{ "x-eumenes-hook-token": token },
			)
		).status,
	).toBe(204);
	expect(terminals.list().sessions[0]!.activity).toBe("working");
	expect(
		(await post({ hook_event_name: "Stop" }, { "x-eumenes-hook-token": token }))
			.status,
	).toBe(204);
	expect(terminals.list().sessions[0]!.activity).toBe("idle");
	terminals.closeAll();
});
