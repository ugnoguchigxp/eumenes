import { afterEach, expect, test } from "bun:test";
import { Hono } from "hono";
import { registerTerminals } from "../controller";
import type { TerminalRequestFinished } from "../contracts";
import { createTerminals } from "../service";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import { fakePty, hooked, until } from "./terminals.fixture";

const open: Array<ReturnType<typeof hooked>> = [];
afterEach(async () => {
	for (const h of open.splice(0)) await h.finish();
});
const make = (...args: Parameters<typeof hooked>) => {
	const h = hooked(...args);
	open.push(h);
	return h;
};

test("an ended run ends its sent request; a queued one is resolved again", async () => {
	const h = make();
	const events: TerminalRequestFinished[] = [];
	h.terminals.onFinishedInTransaction((_tx, e) => events.push(e));
	const request = await h.enqueue({
		owner: "direct",
		target: "current",
		exclusiveGroup: undefined,
		prompt: "x",
	});
	await h.begin(0, "p", "x");
	h.spawned[0]!.exit(1);
	await until(() => h.state(request.attemptId) === "ended");
	expect(h.view(request.attemptId)!.reason).toBe("session_ended");
	expect(events.map((e) => [e.state, e.reason])).toEqual([
		["ended", "session_ended"],
	]);
	expect(h.spawned[0]!.closed).toBe(true);
	expect(h.terminals.list().sessions[0]).toMatchObject({
		status: "exited",
		exitCode: 1,
	});
	// The exited run's token no longer reports.
	await expect(
		h.terminals.hook(h.spawned[0]!.sessionId!, h.spawned[0]!.token!, {
			hook_event_name: "Stop",
		}),
	).rejects.toThrow("terminal_hook_forbidden");
});

test("no SessionStart within the time: unknown (tracking_lost), the PTY is closed, listeners hear it", async () => {
	const h = make({ trackingMs: 30 });
	const events: TerminalRequestFinished[] = [];
	h.terminals.onFinishedInTransaction((_tx, e) => events.push(e));
	const request = await h.enqueue({ prompt: "x" });
	await until(() => h.state(request.attemptId) === "unknown");
	expect(h.view(request.attemptId)!.reason).toBe("tracking_lost");
	expect(events).toHaveLength(1);
	await until(() => h.spawned[0]!.signals.includes("SIGTERM"));
	await until(() => h.terminals.list().sessions[0]!.status === "exited");
	// Ending the run does not rewrite the final state.
	expect(h.state(request.attemptId)).toBe("unknown");
});

test("a first prompt without prompt_id cannot be tracked", async () => {
	const h = make();
	const request = await h.enqueue({ prompt: "x" });
	await h.hook(0, { hook_event_name: "SessionStart", source: "startup" });
	await h.hook(0, { hook_event_name: "UserPromptSubmit", prompt: "x" });
	await until(() => h.state(request.attemptId) === "unknown");
	expect(h.view(request.attemptId)!.reason).toBe("tracking_lost");
	await until(() => h.spawned[0]!.signals.includes("SIGTERM"));
});

test("stop ends the PTY and records unknown (stopped_by_person) once the exit is seen", async () => {
	const h = make();
	const events: TerminalRequestFinished[] = [];
	h.terminals.onFinishedInTransaction((_tx, e) => events.push(e));
	const request = await h.enqueue({ prompt: "長い作業" });
	await h.begin(0, "p", "長い作業");
	await expect(h.terminals.stop(crypto.randomUUID())).rejects.toThrow(
		"terminal_not_found",
	);
	expect(await h.terminals.stop(request.attemptId)).toBe("stopped");
	expect(h.spawned[0]!.signals).toEqual(["SIGTERM"]);
	expect(h.view(request.attemptId)).toMatchObject({
		state: "unknown",
		reason: "stopped_by_person",
	});
	expect(events).toHaveLength(1);
	// Stopping a request that is already final changes nothing and says so.
	expect(await h.terminals.stop(request.attemptId)).toBe("final");
	expect(events).toHaveLength(1);
});

test("a process that ignores SIGTERM is killed after a while; one that survives both is unconfirmed and nothing is written", async () => {
	const h = make(
		{ killAfterMs: 20, stopConfirmMs: 80 },
		fakePty({ ignore: ["SIGTERM"] }),
	);
	const request = await h.enqueue({ prompt: "x" });
	await h.begin(0, "p", "x");
	expect(await h.terminals.stop(request.attemptId)).toBe("stopped");
	expect(h.spawned[0]!.signals).toEqual(["SIGTERM", "SIGKILL"]);

	const stubborn = make(
		{ killAfterMs: 20, stopConfirmMs: 80 },
		fakePty({ ignore: ["SIGTERM", "SIGKILL"] }),
	);
	const kept = await stubborn.enqueue({ prompt: "y" });
	await stubborn.begin(0, "p", "y");
	expect(await stubborn.terminals.stop(kept.attemptId)).toBe("unconfirmed");
	expect(stubborn.state(kept.attemptId)).toBe("started");
	// The request is still carried by the PTY, so it blocks the next Kanban run.
	const next = await stubborn.enqueue({ owner: "kanban:other", prompt: "z" });
	expect(stubborn.state(next.attemptId)).toBe("queued");
	// Late exit is an ordinary end.
	stubborn.spawned[0]!.exit(0);
	await until(() => stubborn.state(kept.attemptId) === "ended");
});

test("recover: unsent requests are cancelled and sent ones become unknown, never sent again", async () => {
	const h = make();
	const events: TerminalRequestFinished[] = [];
	const sent = await h.enqueue({
		owner: "direct",
		target: "current",
		exclusiveGroup: undefined,
		prompt: "送信済み",
	});
	const started = await h.enqueue({ owner: "kanban:a", prompt: "A" });
	await h.begin(1, "p", "A");
	const waiting = await h.enqueue({ owner: "kanban:b", prompt: "B" });
	expect(h.state(waiting.attemptId)).toBe("queued");
	expect(h.state(sent.attemptId)).toBe("delivered");

	// A second process on the same database: the PTYs of the first are gone.
	const restarted = createTerminals({
		command: ["claude"],
		spawn: fakePty().spawn,
		store: h.store,
		hookBaseUrl: "http://127.0.0.1:8787",
		curl: "curl",
	});
	restarted.onFinishedInTransaction((_tx, e) => events.push(e));
	await restarted.recover();
	await restarted.settled();
	expect(events.map((e) => [e.attemptId, e.state, e.reason]).sort()).toEqual(
		[
			[sent.attemptId, "unknown", "restarted"],
			[started.attemptId, "unknown", "restarted"],
			[waiting.attemptId, "cancelled", "restarted"],
		].sort(),
	);
	expect(restarted.list().sessions).toEqual([]);
	restarted.closeAll();
});

test("a final state that cannot be saved is tried once more by the next hook; the hook is answered 503 meanwhile", async () => {
	let failures = 0;
	const h = make({}, fakePty(), (store): SqliteStore => ({
		...store,
		write: (operation) =>
			failures > 0
				? (failures--, Promise.reject(new Error("database_writer_queue_full")))
				: store.write(operation),
	}));
	const app = new Hono();
	registerTerminals(app, h.terminals);
	const request = await h.enqueue({ prompt: "x" });
	await h.begin(0, "p", "x");
	const spawned = h.spawned[0]!;
	const post = (body: unknown) =>
		app.request(`/hooks/terminals/${spawned.sessionId}`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-eumenes-hook-token": spawned.token!,
			},
			body: JSON.stringify({
				session_id: spawned.claudeId,
				...(body as object),
			}),
		});
	failures = 1;
	const stop = await post({
		hook_event_name: "Stop",
		prompt_id: "p",
		last_assistant_message: "終わり",
	});
	expect(stop.status).toBe(503);
	expect(h.state(request.attemptId)).toBe("started");
	// The next hook retries the unsaved final state once.
	expect(
		(
			await post({
				hook_event_name: "Notification",
				notification_type: "idle_prompt",
			})
		).status,
	).toBe(204);
	expect(h.view(request.attemptId)).toMatchObject({
		state: "completed",
		lastReport: "終わり",
	});

	// Failing twice: the request stays started (the board offers to stop it).
	const second = await h.enqueue({ owner: "kanban:two", prompt: "y" });
	await h.begin(1, "q", "y");
	failures = 2;
	const spawned2 = h.spawned[1]!;
	await expect(
		h.terminals.hook(spawned2.sessionId!, spawned2.token!, {
			hook_event_name: "Stop",
			session_id: spawned2.claudeId,
			prompt_id: "q",
		}),
	).rejects.toThrow();
	await h.terminals.hook(spawned2.sessionId!, spawned2.token!, {
		hook_event_name: "Notification",
		session_id: spawned2.claudeId,
		notification_type: "idle_prompt",
	});
	failures = 0;
	expect(h.state(second.attemptId)).toBe("started");
});

test("a failing finished listener rolls the final state back", async () => {
	const h = make();
	const request = await h.enqueue({ prompt: "x" });
	await h.begin(0, "p", "x");
	let broken = true;
	h.terminals.onFinishedInTransaction(() => {
		if (broken) throw new Error("listener_failed");
	});
	const committed: string[] = [];
	h.terminals.onFinishedCommitted((event) => committed.push(event.state));
	await expect(
		h.hook(0, { hook_event_name: "Stop", prompt_id: "p" }),
	).rejects.toThrow();
	expect(h.state(request.attemptId)).toBe("started");
	broken = false;
	await h.hook(0, {
		hook_event_name: "Notification",
		notification_type: "idle_prompt",
	});
	expect(h.state(request.attemptId)).toBe("completed");
});

test("restarting a Kanban session resumes its conversation; a direct one starts a new one", async () => {
	const h = make();
	const task = await h.enqueue({ owner: "kanban:a", prompt: "A" });
	await h.begin(0, "p", "A");
	await h.hook(0, { hook_event_name: "Stop", prompt_id: "p" });
	const direct = h.terminals.start({ cols: 80, rows: 24 });
	h.spawned[0]!.exit(0);
	h.spawned[1]!.exit(0);
	await until(() =>
		h.terminals.list().sessions.every((s) => s.status === "exited"),
	);
	const kanbanId = h.terminals.list().sessions[0]!.id;
	h.terminals.restart(kanbanId, { cols: 90, rows: 30 });
	h.terminals.restart(direct.id, { cols: 90, rows: 30 });
	expect(h.spawned[2]!.resume).toBe(true);
	expect(h.spawned[2]!.claudeId).toBe(h.spawned[0]!.claudeId);
	expect(h.spawned[3]!.resume).toBe(false);
	expect(h.spawned[3]!.claudeId).not.toBe(h.spawned[1]!.claudeId);
	expect(h.state(task.attemptId)).toBe("completed");
	expect(h.terminals.activities().map((a) => [a.owner, a.status])).toEqual([
		["kanban:a", "running"],
		["direct", "running"],
	]);
});

test("the hook route checks the run's token before reading the body", async () => {
	const h = make();
	const app = new Hono();
	registerTerminals(app, h.terminals);
	app.onError((error, c) =>
		c.json(
			{ error: error.message },
			error.message === "terminal_hook_forbidden" ? 403 : 500,
		),
	);
	await h.enqueue({ prompt: "x" });
	const spawned = h.spawned[0]!;
	const post = (body: string, headers: Record<string, string> = {}) =>
		app.request(`/hooks/terminals/${spawned.sessionId}`, {
			method: "POST",
			headers: { "content-type": "application/json", ...headers },
			body,
		});
	const stop = JSON.stringify({
		hook_event_name: "Stop",
		session_id: spawned.claudeId,
	});
	expect((await post(stop)).status).toBe(403);
	// A wrong token is refused even with a body that is not JSON.
	expect(
		(await post("not json", { "x-eumenes-hook-token": "bad" })).status,
	).toBe(403);
	const token = { "x-eumenes-hook-token": spawned.token! };
	// Events this host does not use are accepted and ignored.
	expect(
		(await post(JSON.stringify({ hook_event_name: "PreToolUse" }), token))
			.status,
	).toBe(204);
	expect(h.terminals.activities()[0]!.activity).toBe("working");
	expect((await post(stop, token)).status).toBe(204);
	expect(h.terminals.activities()[0]!.activity).toBe("idle");
});
