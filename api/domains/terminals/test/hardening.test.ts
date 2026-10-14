import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { Hono } from "hono";
import { configureLogging } from "../../../infrastructure/logger";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import { registerTerminals } from "../controller";
import { errorStatus } from "../contracts";
import { headerFileOf } from "../hooks";
import { createTerminals } from "../service";
import {
	fakePty,
	hooked,
	openTestStore,
	requestOf,
	until,
} from "./terminals.fixture";

const open: Array<ReturnType<typeof hooked>> = [];
afterEach(async () => {
	configureLogging({ level: "silent" });
	for (const h of open.splice(0)) await h.finish();
});
const make = (...args: Parameters<typeof hooked>) => {
	const h = hooked(...args);
	open.push(h);
	return h;
};
const captureLog = () => {
	const lines: string[] = [];
	configureLogging({
		level: "info",
		destination: { write: (line: string) => void lines.push(line) },
	});
	return lines;
};

test("nothing is sent before startup recovery; recovery cancels the leftover request as restarted", async () => {
	const db = openTestStore();
	const pty = fakePty();
	const terminals = createTerminals({
		command: ["claude"],
		spawn: pty.spawn,
		store: db.store,
		hookBaseUrl: "http://127.0.0.1:8787",
		curl: "curl",
		sweepMs: 10,
		cwd: db.dir,
	});
	try {
		const request = requestOf();
		await db.store.write((tx) => terminals.enqueueInTransaction(tx, request));
		// Commit notifications and several sweeps pass: a stale request must not be sent.
		await Bun.sleep(80);
		await terminals.settled();
		expect(pty.spawned).toHaveLength(0);
		expect(
			db.store.read((d) => terminals.requestInTransaction(d, request.attemptId))
				?.state,
		).toBe("queued");
		await terminals.recover();
		await terminals.settled();
		expect(
			db.store.read((d) =>
				terminals.requestInTransaction(d, request.attemptId),
			),
		).toMatchObject({ state: "cancelled", reason: "restarted" });
		expect(pty.spawned).toHaveLength(0);
		// After recovery new requests are sent.
		const next = requestOf({ owner: "kanban:next" });
		await db.store.write((tx) => terminals.enqueueInTransaction(tx, next));
		await until(() => pty.spawned.length === 1);
	} finally {
		terminals.closeAll();
		await db.close();
	}
});

test("stop while the PTY is being launched waits for it, then stops it", async () => {
	const attemptId = crypto.randomUUID();
	let stopping: Promise<string> | undefined;
	let stopIt = () => {};
	const h = make(
		{},
		fakePty({
			// The PTY exists but the session is not registered yet.
			onSpawn: () => stopIt(),
		}),
	);
	stopIt = () => {
		stopping = h.terminals.stop(attemptId);
	};
	await h.enqueue({
		attemptId,
		owner: "direct",
		target: "current",
		exclusiveGroup: undefined,
	});
	await until(() => stopping !== undefined);
	expect(await stopping).toBe("stopped");
	expect(h.spawned[0]!.signals).toEqual(["SIGTERM"]);
	expect(h.view(attemptId)).toMatchObject({
		state: "unknown",
		reason: "stopped_by_person",
	});
});

test("stop while the launch fails answers final, never stopped without a final state", async () => {
	const attemptId = crypto.randomUUID();
	let stopping: Promise<string> | undefined;
	let stopIt = () => {};
	const h = make(
		{},
		fakePty({
			onSpawn: () => {
				stopIt();
				throw new Error("spawn_failed");
			},
		}),
	);
	stopIt = () => {
		stopping = h.terminals.stop(attemptId);
	};
	await h.enqueue({ attemptId });
	await until(() => stopping !== undefined);
	expect(await stopping).toBe("final");
	expect(h.view(attemptId)).toMatchObject({
		state: "cancelled",
		reason: "send_failed",
	});
});

test("stop while a request is being marked sent into an idle PTY waits and then stops that PTY", async () => {
	let gate: Promise<void> | undefined;
	let release = () => {};
	let real!: SqliteStore;
	const h = make({}, fakePty(), (store): SqliteStore => {
		real = store;
		return {
			...store,
			write: (operation) =>
				gate ? gate.then(() => store.write(operation)) : store.write(operation),
		};
	});
	const claudeSessionId = crypto.randomUUID();
	const first = await h.enqueue({
		target: "new",
		claudeSessionId,
		prompt: "最初",
	});
	await h.begin(0, "p1", "最初");
	await h.hook(0, { hook_event_name: "Stop", prompt_id: "p1" });
	await until(() => h.state(first.attemptId) === "completed");

	gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const second = requestOf({
		target: "conversation",
		claudeSessionId,
		prompt: "続き",
	});
	await real.write((tx) => h.terminals.enqueueInTransaction(tx, second));
	// The sender is now saving `sending` (held); the request still reads as queued.
	await Bun.sleep(30);
	let done = false;
	const stopping = h.terminals.stop(second.attemptId).then((r) => {
		done = true;
		return r;
	});
	await Bun.sleep(40);
	expect(done).toBe(false);
	release();
	gate = undefined;
	expect(await stopping).toBe("stopped");
	expect(h.spawned[0]!.signals).toEqual(["SIGTERM"]);
	expect(h.view(second.attemptId)).toMatchObject({
		state: "unknown",
		reason: "stopped_by_person",
	});
});

test("a Kanban PTY left working by Esc stops holding the queue after 30 minutes without a hook", async () => {
	let at = Date.now();
	const h = make({ now: () => new Date(at), sweepMs: 20 });
	const a = await h.enqueue({ owner: "kanban:a", prompt: "A" });
	await h.begin(0, "pa", "A");
	// The person typed another prompt (the request is interrupted) and then pressed Esc: no Stop.
	await h.hook(0, {
		hook_event_name: "UserPromptSubmit",
		prompt_id: "manual",
		prompt: "手で",
	});
	expect(h.state(a.attemptId)).toBe("interrupted");
	const b = await h.enqueue({ owner: "kanban:b", prompt: "B" });
	await Bun.sleep(80);
	expect(h.state(b.attemptId)).toBe("queued");
	expect(h.terminals.activities()[0]).toMatchObject({ activity: "working" });
	expect(h.terminals.activities()[0]!.stale).toBeUndefined();

	at += 31 * 60 * 1000;
	expect(h.terminals.activities()[0]).toMatchObject({
		activity: "working",
		stale: true,
	});
	await until(() => h.state(b.attemptId) === "delivered");
});

test("a turn with a request in flight never counts as stale", async () => {
	let at = Date.now();
	const h = make({ now: () => new Date(at) });
	await h.enqueue({ owner: "kanban:a", prompt: "A" });
	await h.begin(0, "pa", "A");
	at += 120 * 60 * 1000;
	expect(h.terminals.activities()[0]!.stale).toBeUndefined();
	const b = await h.enqueue({ owner: "kanban:b", prompt: "B" });
	expect(h.state(b.attemptId)).toBe("queued");
});

test("control characters other than line feed and tab are refused when a request is saved", async () => {
	const h = make();
	await h.ready;
	const save = (prompt: string) =>
		h.store.write((tx) =>
			h.terminals.enqueueInTransaction(tx, requestOf({ prompt })),
		);
	for (const prompt of [
		"前\x1b[201~残り",
		"a\rb",
		"a\x00b",
		"a\x7fb",
		"a\u0085b",
		"a\u009bb",
	])
		await expect(save(prompt)).rejects.toThrow("terminal_prompt_invalid");
	await expect(save("1行目\n\t2行目")).resolves.toBeDefined();
	expect(errorStatus.terminal_prompt_invalid).toBe(400);
	expect(errorStatus.terminal_conversation_busy).toBe(409);
});

test("an ESC that reached a saved request is dropped when it is pasted", async () => {
	const h = make();
	const claudeSessionId = crypto.randomUUID();
	await h.enqueue({ target: "new", claudeSessionId, prompt: "最初" });
	await h.begin(0, "p1", "最初");
	await h.hook(0, { hook_event_name: "Stop", prompt_id: "p1" });
	const id = crypto.randomUUID();
	await h.store.write((tx) => {
		tx.query(
			`INSERT INTO terminal_requests (id, digest, state, owner, target, mode, project_id, task, prompt, origin, claude_session_id, exclusive_group, created_at, updated_at)
			 VALUES (?, 'x', 'queued', 'kanban:card-1', 'conversation', 'work', 'eumenes', 't', ?, 'board', ?, 'kanban', ?, ?)`,
		).run(
			id,
			"前\x1b[201~echo bad",
			claudeSessionId,
			"2026-01-01",
			"2026-01-01",
		);
	});
	await until(() => h.state(id) === "delivered");
	expect(h.spawned[0]!.writes[0]).toBe("\x1b[200~前[201~echo bad\x1b[201~");
});

test("final requests older than 30 days go, at most the newest 2000 final ones stay, open ones stay", async () => {
	const h = make();
	await h.ready;
	const now = new Date("2026-10-14T00:00:00.000Z");
	const insert = (id: string, state: string, updatedAt: string) =>
		h.store.write((tx) => {
			tx.query(
				`INSERT INTO terminal_requests (id, digest, state, owner, target, mode, project_id, task, prompt, origin, created_at, updated_at)
				 VALUES (?, 'x', ?, 'direct', 'current', 'work', 'eumenes', 't', 'p', 'board', ?, ?)`,
			).run(id, state, updatedAt, updatedAt);
		});
	await insert("old-final", "completed", "2026-09-01T00:00:00.000Z");
	await insert("old-open", "queued", "2026-01-01T00:00:00.000Z");
	await insert("recent", "unknown", "2026-10-13T23:59:30.000Z");
	await h.store.write((tx) => {
		const statement = tx.query(
			`INSERT INTO terminal_requests (id, digest, state, owner, target, mode, project_id, task, prompt, origin, created_at, updated_at)
			 VALUES (?, 'x', 'completed', 'direct', 'current', 'work', 'eumenes', 't', 'p', 'board', ?, ?)`,
		);
		for (let i = 0; i < 2100; i++) {
			const at = new Date(now.getTime() - 60_000 - i * 1000).toISOString();
			statement.run(`bulk-${i}`, at, at);
		}
	});
	const deleted = await h.store.write((tx) =>
		h.terminals.pruneInTransaction(tx, now),
	);
	// 1 aged out; 2101 recent finals -> 2000 kept.
	expect(deleted).toBe(1 + 101);
	const ids = h.store.read((db) =>
		(
			db.query("SELECT id, state FROM terminal_requests").all() as Array<{
				id: string;
				state: string;
			}>
		).map((r) => r.id),
	);
	expect(ids).toContain("old-open");
	expect(ids).toContain("recent");
	expect(ids).not.toContain("old-final");
	expect(ids).toContain("bulk-0");
	expect(ids).not.toContain("bulk-2099");
	expect(ids).toHaveLength(2001);
});

test("a large PostToolUse is accepted; one beyond the bound is refused and logged with the request only", async () => {
	const h = make();
	const app = new Hono();
	registerTerminals(app, h.terminals);
	const request = await h.enqueue({ prompt: "x" });
	await h.begin(0, "p", "x");
	const spawned = h.spawned[0]!;
	const post = (body: string) =>
		app.request(`/hooks/terminals/${spawned.sessionId}`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-eumenes-hook-token": spawned.token!,
			},
			body,
		});
	const tool = (size: number) =>
		JSON.stringify({
			session_id: spawned.claudeId,
			hook_event_name: "PostToolUse",
			prompt_id: "p",
			tool_name: "Write",
			tool_input: { file_path: "big.txt", content: "x".repeat(size) },
		});
	expect((await post(tool(1024 * 1024))).status).toBe(204);
	expect(h.view(request.attemptId)!.files).toEqual(["big.txt"]);
	const lines = captureLog();
	expect((await post(tool(5 * 1024 * 1024))).status).toBe(413);
	const entry = lines
		.map((line) => JSON.parse(line) as Record<string, unknown>)
		.find((e) => e.event === "terminals.hook_too_large");
	expect(entry).toMatchObject({ attemptId: request.attemptId });
	expect(JSON.stringify(entry)).not.toContain("xxxx");
});

test("the hook token is in a private header file, not in the settings or any process argument", async () => {
	const h = make();
	await h.enqueue({ prompt: "x" });
	const spawned = h.spawned[0]!;
	const settingsPath =
		spawned.command[spawned.command.indexOf("--settings") + 1]!;
	const header = headerFileOf(settingsPath);
	expect(readFileSync(settingsPath, "utf8")).not.toContain(spawned.token!);
	expect(readFileSync(settingsPath, "utf8")).toContain(`-H @'${header}'`);
	expect(readFileSync(header, "utf8")).toBe(
		`x-eumenes-hook-token: ${spawned.token}\n`,
	);
	expect(statSync(header).mode & 0o777).toBe(0o600);
	expect(JSON.stringify(spawned.command)).not.toContain(spawned.token!);
	spawned.exit(0);
	await until(() => !existsSync(settingsPath));
	expect(existsSync(header)).toBe(false);
});

test("/clear changes Claude's session id: the request is interrupted and the new id is followed", async () => {
	const h = make();
	const a = await h.enqueue({ owner: "kanban:a", prompt: "A" });
	await h.begin(0, "pa", "A");
	expect(h.state(a.attemptId)).toBe("started");
	const cleared = crypto.randomUUID();
	await h.hook(0, {
		hook_event_name: "SessionStart",
		session_id: cleared,
		source: "clear",
	});
	expect(h.view(a.attemptId)).toMatchObject({ state: "interrupted" });
	// The request keeps its own conversation id; activity follows the new one.
	expect(h.view(a.attemptId)!.claudeSessionId).toBe(h.spawned[0]!.claudeId);
	expect(h.terminals.activities()[0]).toMatchObject({
		claudeSessionId: h.spawned[0]!.claudeId,
		activity: "idle",
	});
	await h.hook(0, {
		hook_event_name: "UserPromptSubmit",
		session_id: cleared,
		prompt_id: "q",
		prompt: "手で",
	});
	expect(h.terminals.activities()[0]!.activity).toBe("working");
	await h.hook(0, {
		hook_event_name: "Stop",
		session_id: cleared,
		prompt_id: "q",
	});
	expect(h.terminals.activities()[0]!.activity).toBe("idle");
	// A third conversation's hooks are still ignored.
	await h.hook(0, {
		hook_event_name: "UserPromptSubmit",
		session_id: crypto.randomUUID(),
		prompt_id: "z",
		prompt: "他",
	});
	expect(h.terminals.activities()[0]!.activity).toBe("idle");
});

test("tracking lost: the request is marked only after the exit is confirmed", async () => {
	const h = make(
		{ trackingMs: 30, killAfterMs: 250, stopConfirmMs: 3000 },
		fakePty({ ignore: ["SIGTERM"] }),
	);
	const request = await h.enqueue({ prompt: "x" });
	await until(() => h.spawned[0]!.signals.includes("SIGTERM"));
	expect(h.state(request.attemptId)).toBe("delivered");
	await until(() => h.state(request.attemptId) === "unknown");
	expect(h.spawned[0]!.signals).toEqual(["SIGTERM", "SIGKILL"]);
	expect(h.view(request.attemptId)!.reason).toBe("tracking_lost");
});

test("tracking lost with a process that does not end: unknown (stop_unconfirmed) so Kanban pauses", async () => {
	const h = make(
		{ trackingMs: 30, killAfterMs: 20, stopConfirmMs: 80 },
		fakePty({ ignore: ["SIGTERM", "SIGKILL"] }),
	);
	const request = await h.enqueue({ prompt: "x" });
	await until(() => h.state(request.attemptId) === "unknown");
	expect(h.view(request.attemptId)!.reason).toBe("stop_unconfirmed");
});

test("restarting an exited Kanban session is refused while another PTY holds its conversation", async () => {
	const h = make();
	const claudeSessionId = crypto.randomUUID();
	const first = await h.enqueue({
		owner: "kanban:card",
		target: "new",
		claudeSessionId,
	});
	await h.begin(0, "p1", h.view(first.attemptId) ? first.prompt : "");
	h.spawned[0]!.exit(0);
	await until(() => h.state(first.attemptId) === "ended");
	const exited = h.terminals.list().sessions[0]!;
	const second = await h.enqueue({
		owner: "kanban:card",
		target: "conversation",
		claudeSessionId,
	});
	await until(() => h.spawned.length === 2);
	expect(h.state(second.attemptId)).toBe("delivered");
	expect(() => h.terminals.restart(exited.id, { cols: 80, rows: 24 })).toThrow(
		"terminal_conversation_busy",
	);
	h.spawned[1]!.exit(0);
	await until(() => h.state(second.attemptId) === "ended");
	expect(h.terminals.restart(exited.id, { cols: 80, rows: 24 })).toMatchObject({
		status: "running",
	});
});

test("every Kanban request is of the kanban group, whatever the caller sent", async () => {
	const h = make();
	const a = await h.enqueue({ owner: "kanban:a", exclusiveGroup: undefined });
	const b = await h.enqueue({ owner: "kanban:b", exclusiveGroup: undefined });
	expect(h.state(a.attemptId)).toBe("delivered");
	expect(h.state(b.attemptId)).toBe("queued");
	const groups = h.store.read(
		(db) =>
			db
				.query(
					"SELECT exclusive_group AS g FROM terminal_requests ORDER BY rowid",
				)
				.all() as Array<{ g: string }>,
	);
	expect(groups.map((r) => r.g)).toEqual(["kanban", "kanban"]);
});

test("typing keeps one pending wake-up per PTY", async () => {
	const h = make({ manualInputWaitMs: 7777 });
	const session = h.terminals.start({ cols: 80, rows: 24 });
	const pending = new Set<unknown>();
	const set = globalThis.setTimeout;
	const clear = globalThis.clearTimeout;
	globalThis.setTimeout = ((
		fn: () => void,
		ms?: number,
		...rest: unknown[]
	) => {
		const timer = (set as (...a: unknown[]) => unknown)(fn, ms, ...rest);
		if (ms === 7797) pending.add(timer);
		return timer;
	}) as unknown as typeof setTimeout;
	globalThis.clearTimeout = ((timer: unknown) => {
		pending.delete(timer);
		return (clear as (t: unknown) => void)(timer);
	}) as unknown as typeof clearTimeout;
	try {
		for (let i = 0; i < 50; i++) h.terminals.input(session.id, "a");
		expect(pending.size).toBe(1);
	} finally {
		globalThis.setTimeout = set;
		globalThis.clearTimeout = clear;
	}
});

test("a conversation request is never pasted into a PTY that was cleared; that PTY is closed and the conversation resumed", async () => {
	const h = make();
	const claudeSessionId = crypto.randomUUID();
	const first = await h.enqueue({
		owner: "kanban:card",
		target: "new",
		claudeSessionId,
		prompt: "最初",
	});
	await h.begin(0, "p1", "最初");
	await h.hook(0, { hook_event_name: "Stop", prompt_id: "p1" });
	await until(() => h.state(first.attemptId) === "completed");
	await h.hook(0, {
		hook_event_name: "SessionStart",
		session_id: crypto.randomUUID(),
		source: "clear",
	});
	const second = await h.enqueue({
		owner: "kanban:card",
		target: "conversation",
		claudeSessionId,
		prompt: "続き",
	});
	await until(() => h.spawned.length === 2);
	// Nothing was typed into the cleared PTY; it was closed, and a new run resumed the original.
	expect(h.spawned[0]!.writes).toEqual([]);
	expect(h.spawned[0]!.killed).toBe(true);
	expect(h.spawned[1]!.resume).toBe(true);
	expect(h.spawned[1]!.claudeId).toBe(claudeSessionId);
	expect(h.spawned[1]!.command.at(-1)).toBe("続き");
	await until(() => h.state(second.attemptId) === "delivered");
});
