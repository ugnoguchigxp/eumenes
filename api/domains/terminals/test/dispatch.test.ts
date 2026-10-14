import { afterEach, expect, test } from "bun:test";
import type { TerminalRequestFinished } from "../contracts";
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
const direct = {
	owner: "direct",
	target: "current",
	exclusiveGroup: undefined,
} as const;

/** Runs a task to its Stop on the n-th PTY. */
async function complete(
	h: ReturnType<typeof make>,
	n: number,
	prompt: string,
	id = `p${n}`,
) {
	await h.begin(n, id, prompt);
	await h.hook(n, {
		hook_event_name: "Stop",
		prompt_id: id,
		last_assistant_message: "ok",
	});
}

test("a follow-up of a conversation is pasted into its idle PTY, and waits while it works", async () => {
	const h = make();
	const first = await h.enqueue({ prompt: "最初" });
	const claudeId = h.spawned[0]!.claudeId;
	await h.begin(0, "p1", "最初");
	const follow = await h.enqueue({
		target: "conversation",
		claudeSessionId: claudeId,
		prompt: "追加",
	});
	// Still working: not pasted into a screen that is busy.
	expect(h.state(follow.attemptId)).toBe("queued");
	expect(h.spawned[0]!.writes).toEqual([]);
	await h.hook(0, { hook_event_name: "Stop", prompt_id: "p1" });
	await until(() => h.state(follow.attemptId) === "delivered");
	expect(h.state(first.attemptId)).toBe("completed");
	expect(h.spawned).toHaveLength(1);
	expect(h.spawned[0]!.writes[0]).toBe("\x1b[200~追加\x1b[201~");
});

test("with no live PTY of the conversation it is resumed with the saved conversation id", async () => {
	const h = make();
	await h.enqueue({ prompt: "最初" });
	const claudeId = h.spawned[0]!.claudeId;
	await complete(h, 0, "最初");
	h.spawned[0]!.exit(0);
	await until(() => h.terminals.list().sessions[0]!.status === "exited");
	const follow = await h.enqueue({
		target: "conversation",
		claudeSessionId: claudeId,
		prompt: "追加で直して",
	});
	await until(() => h.spawned.length === 2);
	const resumed = h.spawned[1]!;
	expect(resumed.command.slice(0, 3)).toEqual(["claude", "--resume", claudeId]);
	expect(resumed.command[3]).toBe("--settings");
	expect(resumed.command.at(-1)).toBe("追加で直して");
	expect(resumed.settings!.permissions).toBeDefined();
	// A resumed run reports SessionStart (source resume) and then the turn.
	await h.hook(1, { hook_event_name: "SessionStart", source: "resume" });
	await h.hook(1, {
		hook_event_name: "UserPromptSubmit",
		prompt_id: "r1",
		prompt: "追加で直して",
	});
	await h.hook(1, {
		hook_event_name: "Stop",
		prompt_id: "r1",
		last_assistant_message: "直しました",
	});
	expect(h.view(follow.attemptId)).toMatchObject({
		state: "completed",
		lastReport: "直しました",
	});
	// Exited entries stay in the list; only the live process counts.
	expect(h.terminals.list().sessions.map((s) => s.status)).toEqual([
		"exited",
		"running",
	]);
});

test("a conversation that cannot be resumed ends the request as resume_failed", async () => {
	const h = make();
	const follow = await h.enqueue({
		target: "conversation",
		claudeSessionId: crypto.randomUUID(),
		prompt: "どこへ",
	});
	expect(h.spawned[0]!.resume).toBe(true);
	h.spawned[0]!.exit(1);
	await until(() => h.state(follow.attemptId) === "ended");
	expect(h.view(follow.attemptId)!.reason).toBe("resume_failed");
});

test("a request of the other mode replaces the idle PTY of the conversation", async () => {
	const h = make();
	await h.enqueue({ prompt: "作業" });
	const claudeId = h.spawned[0]!.claudeId;
	await complete(h, 0, "作業");
	const commit = await h.enqueue({
		target: "conversation",
		claudeSessionId: claudeId,
		mode: "commit",
		prompt: "commit して",
	});
	await until(() => h.spawned.length === 2);
	expect(h.spawned[0]!.killed).toBe(true);
	expect(h.spawned[1]!.command.slice(1, 3)).toEqual(["--resume", claudeId]);
	// A `commit` run is launched without the git restriction.
	expect(h.spawned[1]!.settings!.permissions).toBeUndefined();
	expect(h.state(commit.attemptId)).toBe("delivered");

	// A later follow-up is a `work` run again: a new run with the restriction.
	await complete(h, 1, "commit して");
	h.spawned[1]!.exit(0);
	const again = await h.enqueue({
		target: "conversation",
		claudeSessionId: claudeId,
		prompt: "さらに",
	});
	await until(() => h.spawned.length === 3);
	expect(h.spawned[2]!.settings!.permissions).toBeDefined();
	expect(h.state(again.attemptId)).toBe("delivered");
});

test("Kanban runs one at a time, also against a turn the person started in a Kanban PTY", async () => {
	const h = make();
	const a = await h.enqueue({ owner: "kanban:a", prompt: "A" });
	const b = await h.enqueue({ owner: "kanban:b", prompt: "B" });
	const c = await h.enqueue({ owner: "kanban:c", prompt: "C" });
	expect(h.spawned).toHaveLength(1);
	expect([h.state(b.attemptId), h.state(c.attemptId)]).toEqual([
		"queued",
		"queued",
	]);
	await h.begin(0, "pa", "A");
	await h.hook(0, {
		hook_event_name: "Notification",
		prompt_id: "pa",
		notification_type: "permission_prompt",
	});
	expect(h.spawned).toHaveLength(1);
	await h.hook(0, {
		hook_event_name: "PostToolUse",
		prompt_id: "pa",
		tool_name: "Bash",
	});
	await h.hook(0, { hook_event_name: "Stop", prompt_id: "pa" });
	await until(() => h.spawned.length === 2);
	expect(h.state(a.attemptId)).toBe("completed");
	expect(h.state(b.attemptId)).toBe("delivered");
	expect(h.state(c.attemptId)).toBe("queued");

	// The person types in the idle PTY of card A: until that turn stops, nothing new is sent.
	await h.hook(0, {
		hook_event_name: "UserPromptSubmit",
		prompt_id: "manual",
		prompt: "手で",
	});
	await complete(h, 1, "B");
	await h.terminals.settled();
	expect(h.state(c.attemptId)).toBe("queued");
	await h.hook(0, { hook_event_name: "Stop", prompt_id: "manual" });
	await until(() => h.state(c.attemptId) === "delivered");
});

test("five tasks run one after another with a limit of two live processes: idle Kanban PTYs are closed oldest first", async () => {
	const h = make({ limit: 2 });
	const ids: string[] = [];
	for (let i = 0; i < 5; i++)
		ids.push(
			(await h.enqueue({ owner: `kanban:card-${i}`, prompt: `タスク${i}` }))
				.attemptId,
		);
	for (let i = 0; i < 5; i++) {
		await until(() => h.spawned.length === i + 1);
		await complete(h, i, `タスク${i}`);
		await until(() => h.state(ids[i]!) === "completed");
	}
	expect(ids.map((id) => h.state(id))).toEqual(Array(5).fill("completed"));
	// Every task had its own conversation and PTY.
	expect(new Set(h.spawned.map((s) => s.claudeId)).size).toBe(5);
	expect(h.spawned.map((s) => s.killed)).toEqual([
		true,
		true,
		true,
		false,
		false,
	]);
	const live = h.terminals.activities().filter((a) => a.status === "running");
	expect(live).toHaveLength(2);
});

test("a direct session is never closed to make room; the request waits", async () => {
	const h = make({ limit: 1 });
	const direct1 = await h.enqueue({ ...direct, prompt: "直接" });
	await complete(h, 0, "直接");
	const task = await h.enqueue({ owner: "kanban:a", prompt: "ボード" });
	await h.terminals.settled();
	expect(h.state(task.attemptId)).toBe("queued");
	expect(h.spawned).toHaveLength(1);
	expect(h.spawned[0]!.killed).toBe(false);
	expect(h.state(direct1.attemptId)).toBe("completed");
});

test("direct requests go to the direct PTY only, and reuse the pane of an ended run", async () => {
	const h = make();
	const task = await h.enqueue({ owner: "kanban:a", prompt: "ボード" });
	await h.begin(0, "k1", "ボード");
	const first = await h.enqueue({ ...direct, prompt: "直接1", task: "直接" });
	// Not into the Kanban PTY: a direct PTY of its own.
	expect(h.spawned).toHaveLength(2);
	expect(h.spawned[0]!.writes).toEqual([]);
	expect(h.terminals.list().sessions.map((s) => s.owner)).toEqual([
		"kanban:a",
		"direct",
	]);
	expect(h.terminals.list().sessions[1]!.title).toMatch(/^Claude Code \d+$/);
	expect(h.terminals.list().requests).toBe(1);
	await complete(h, 1, "直接1");
	const second = await h.enqueue({ ...direct, prompt: "直接2", task: "直接" });
	expect(h.spawned).toHaveLength(2);
	expect(h.spawned[1]!.writes[0]).toBe("\x1b[200~直接2\x1b[201~");
	await h.hook(1, {
		hook_event_name: "UserPromptSubmit",
		prompt_id: "d2",
		prompt: "直接2",
	});
	h.spawned[1]!.exit(0);
	await until(() => h.state(second.attemptId) === "ended");
	const third = await h.enqueue({ ...direct, prompt: "直接3", task: "直接" });
	await until(() => h.spawned.length === 3);
	// The ended pane is started again: one direct pane in the list.
	expect(
		h.terminals.list().sessions.filter((s) => s.owner === "direct"),
	).toHaveLength(1);
	expect(h.terminals.list().sessions[1]!.run).toBe(2);
	expect(h.spawned[2]!.command.at(-1)).toBe("直接3");
	expect([task, first, third].map((r) => h.state(r.attemptId))).toEqual([
		"started",
		"completed",
		"delivered",
	]);
});

test("a spawn or paste that fails cancels the request as send_failed and tells the listeners", async () => {
	let failSpawn = true;
	const pty = fakePty({
		onSpawn() {
			if (failSpawn) throw new Error("spawn_failed");
		},
	});
	const h = make({}, pty);
	const events: TerminalRequestFinished[] = [];
	h.terminals.onFinishedInTransaction((_tx, event) => events.push(event));
	const spawnFail = await h.enqueue({ prompt: "起動できない" });
	expect(h.view(spawnFail.attemptId)).toMatchObject({
		state: "cancelled",
		reason: "send_failed",
	});
	expect(events.map((e) => [e.state, e.reason])).toEqual([
		["cancelled", "send_failed"],
	]);
	expect(h.spawned).toHaveLength(0);

	failSpawn = false;
	const ok = await h.enqueue({
		owner: "direct",
		target: "current",
		exclusiveGroup: undefined,
		prompt: "x",
	});
	await complete(h, 0, "x");
	// The next write to the live PTY fails.
	const session = h.spawned[0]!;
	const original = session.writes.push.bind(session.writes);
	session.writes.push = () => {
		throw new Error("write_failed");
	};
	const pasteFail = await h.enqueue({
		owner: "direct",
		target: "current",
		exclusiveGroup: undefined,
		prompt: "y",
	});
	session.writes.push = original;
	expect(h.view(pasteFail.attemptId)).toMatchObject({
		state: "cancelled",
		reason: "send_failed",
	});
	expect(h.state(ok.attemptId)).toBe("completed");
	// A request that failed to send is not sent again.
	await h.terminals.settled();
	expect(session.writes).toEqual([]);
});

test("a queued request can be cancelled until it is sent", async () => {
	const h = make();
	await h.enqueue({ owner: "kanban:a", prompt: "A" });
	const waiting = await h.enqueue({ owner: "kanban:b", prompt: "B" });
	expect(h.state(waiting.attemptId)).toBe("queued");
	expect(
		await h.store.write((tx) =>
			h.terminals.cancelQueuedInTransaction(tx, waiting.attemptId),
		),
	).toBe(true);
	expect(h.view(waiting.attemptId)).toMatchObject({
		state: "cancelled",
		reason: "cancelled_by_person",
	});
	// Sent requests and unknown ids cannot be cancelled.
	const sent = h.spawned[0]!.sessionId!;
	const first = h.terminals
		.activities()
		.find((a) => a.terminalSessionId === sent)!;
	expect(first.owner).toBe("kanban:a");
	expect(
		await h.store.write((tx) =>
			h.terminals.cancelQueuedInTransaction(tx, crypto.randomUUID()),
		),
	).toBe(false);
	await h.begin(0, "p", "A");
	await h.hook(0, { hook_event_name: "Stop", prompt_id: "p" });
	await h.terminals.settled();
	expect(h.spawned).toHaveLength(1);
});

test("only the live processes count against the limit, and eight ended sessions stay listed", async () => {
	const h = make({ limit: 2 });
	for (let i = 0; i < 12; i++) {
		const s = h.terminals.start({ cols: 80, rows: 24 });
		h.spawned[i]!.exit(0);
		await until(
			() =>
				h.terminals.list().sessions.find((x) => x.id === s.id)?.status ===
				"exited",
		);
	}
	const list = h.terminals.list().sessions;
	expect(list.filter((s) => s.status === "exited")).toHaveLength(8);
	h.terminals.start({ cols: 80, rows: 24 });
	h.terminals.start({ cols: 80, rows: 24 });
	expect(() => h.terminals.start({ cols: 80, rows: 24 })).toThrow(
		"terminal_limit_reached",
	);
});
