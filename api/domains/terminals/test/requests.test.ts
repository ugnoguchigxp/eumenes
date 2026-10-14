import { afterEach, expect, test } from "bun:test";
import { statSync } from "node:fs";
import type { Database } from "bun:sqlite";
import type { TerminalRequestFinished } from "../contracts";
import { fakePty, hooked, requestOf, until } from "./terminals.fixture";

const open: Array<ReturnType<typeof hooked>> = [];
afterEach(async () => {
	for (const h of open.splice(0)) await h.finish();
});
const make = (...args: Parameters<typeof hooked>) => {
	const h = hooked(...args);
	open.push(h);
	return h;
};

test("a request is saved in the caller's transaction and nothing is sent before it commits", async () => {
	const h = make();
	const request = requestOf();
	await expect(
		h.store.write((tx) => {
			h.terminals.enqueueInTransaction(tx, request);
			throw new Error("rolled_back");
		}),
	).rejects.toThrow("rolled_back");
	await h.terminals.settled();
	expect(h.view(request.attemptId)).toBeNull();
	expect(h.spawned).toHaveLength(0);

	await h.store.write((tx) => h.terminals.enqueueInTransaction(tx, request));
	await h.terminals.settled();
	expect(h.spawned).toHaveLength(1);
});

test("the same id is a replay; a different body under it is a conflict; unknown projects and untrackable hosts are refused", async () => {
	const h = make();
	const request = requestOf({ exclusiveGroup: undefined });
	const first = await h.store.write((tx) =>
		h.terminals.enqueueInTransaction(tx, request),
	);
	expect(first).toMatchObject({
		id: request.attemptId,
		state: "queued",
		files: [],
	});
	await h.terminals.settled();
	// The replay returns what is saved now, and does not send again.
	const replay = await h.store.write((tx) =>
		h.terminals.enqueueInTransaction(tx, request),
	);
	expect(replay.id).toBe(request.attemptId);
	expect(replay.state).toBe("delivered");
	expect(h.spawned).toHaveLength(1);
	await expect(
		h.store.write((tx) =>
			h.terminals.enqueueInTransaction(tx, { ...request, prompt: "別の中身" }),
		),
	).rejects.toThrow("terminal_request_conflict");
	await expect(
		h.store.write((tx) =>
			h.terminals.enqueueInTransaction(tx, requestOf({ projectId: "other" })),
		),
	).rejects.toThrow("terminal_project_unknown");
	await expect(
		h.store.write((tx) =>
			h.terminals.enqueueInTransaction(
				tx,
				requestOf({ target: "conversation" }),
			),
		),
	).rejects.toThrow();

	const blind = make({ hookBaseUrl: undefined });
	expect(blind.terminals.trackable()).toBe(false);
	await expect(
		blind.store.write((tx) =>
			blind.terminals.enqueueInTransaction(tx, requestOf()),
		),
	).rejects.toThrow("terminal_tracking_unavailable");
	const noCurl = make({ curl: null });
	expect(noCurl.terminals.trackable()).toBe(false);
	// A request saved before is still readable without tracking.
	expect(h.terminals.trackable()).toBe(true);
});

test("a task starts a new conversation: sending is saved before the PTY is spawned", async () => {
	const states: string[] = [];
	let probe: (id: string) => string | undefined = () => undefined;
	const h = make(
		{},
		fakePty({
			onSpawn() {
				states.push(probe("pending") ?? "none");
			},
		}),
	);
	probe = () => {
		const row = h.store.read(
			(db) =>
				db.query("SELECT state FROM terminal_requests").get() as {
					state: string;
				} | null,
		);
		return row?.state;
	};
	const request = await h.enqueue({
		owner: "kanban:card-1",
		prompt: "README を直して",
	});
	expect(states).toEqual(["sending"]);
	const spawned = h.spawned[0]!;
	expect(spawned.command.slice(0, 2)).toEqual(["claude", "--session-id"]);
	expect(spawned.command[3]).toBe("--settings");
	expect(spawned.command.at(-1)).toBe("README を直して");
	expect(spawned.cwd).toBe(h.dir);
	// The token stays in a 0600 file, never in the process arguments.
	expect(spawned.command.join(" ")).not.toMatch(/[0-9a-f]{64}/);
	expect(h.view(request.attemptId)).toMatchObject({
		state: "delivered",
		terminalSessionId: spawned.sessionId,
		claudeSessionId: spawned.claudeId,
	});
	expect(h.terminals.list().sessions[0]).toMatchObject({
		owner: "kanban:card-1",
		mode: "work",
		title: request.task,
		task: request.task,
		activity: "working",
	});
	expect(h.terminals.list().requests).toBe(0);
});

test("only work sessions of a Kanban card deny git commit and git push", async () => {
	const h = make();
	await h.enqueue({
		owner: "kanban:a",
		mode: "work",
		prompt: "修正して commit・push まで",
	});
	await h.hook(0, { hook_event_name: "SessionStart" });
	const work = h.spawned[0]!;
	expect(
		statSync(work.command[work.command.indexOf("--settings") + 1]!).mode &
			0o777,
	).toBe(0o600);
	expect(work.settings!.permissions).toEqual({
		deny: ["Bash(git commit *)", "Bash(git push *)"],
	});
	expect(Object.keys(work.settings!.hooks).sort()).toEqual([
		"Notification",
		"PostToolUse",
		"SessionStart",
		"Stop",
		"UserPromptSubmit",
	]);
	// The text is sent as it was saved: the restriction is in the settings, not in the text.
	expect(work.command.at(-1)).toBe("修正して commit・push まで");

	// The second Kanban run waits for the first; a direct one does not.
	await h.enqueue({ owner: "kanban:b", mode: "commit", target: "new" });
	expect(h.spawned).toHaveLength(1);
	await h.enqueue({
		owner: "direct",
		target: "new",
		exclusiveGroup: undefined,
	});
	expect(h.spawned).toHaveLength(2);
	expect(h.spawned[1]!.settings!.permissions).toBeUndefined();
	await h.hook(0, {
		hook_event_name: "UserPromptSubmit",
		prompt_id: "p",
		prompt: "修正して commit・push まで",
	});
	await h.hook(0, { hook_event_name: "Stop", prompt_id: "p" });
	await until(() => h.spawned.length === 3);
	expect(h.spawned[2]!.settings!.permissions).toBeUndefined();
});

test("hooks tie a turn to its request by prompt_id: start, edited files, permission wait, completion", async () => {
	const h = make();
	const waiting: Array<{ attemptId: string; owner: string }> = [];
	h.terminals.onWaitingInTransaction((_tx, event) => waiting.push(event));
	const finished: TerminalRequestFinished[] = [];
	let inTransaction = false;
	h.terminals.onFinishedInTransaction((tx: Database, event) => {
		inTransaction = tx.inTransaction;
		finished.push(event);
	});
	const request = await h.enqueue({ prompt: "A をして", task: "A" });
	await h.hook(0, { hook_event_name: "SessionStart", source: "startup" });
	// A turn the person typed is not the request: it stays delivered.
	await h.hook(0, {
		hook_event_name: "UserPromptSubmit",
		prompt_id: "manual",
		prompt: "別の作業",
	});
	expect(h.state(request.attemptId)).toBe("delivered");
	await h.hook(0, { hook_event_name: "Stop", prompt_id: "manual" });
	expect(h.state(request.attemptId)).toBe("delivered");

	await h.hook(0, {
		hook_event_name: "UserPromptSubmit",
		prompt_id: "p1",
		prompt: '<pasted_content id="1a">\nA   をして\n</pasted_content id="1a">',
	});
	expect(h.view(request.attemptId)).toMatchObject({
		state: "started",
		promptId: "p1",
	});
	const edit = (file: string, tool = "Edit", key = "file_path") =>
		h.hook(0, {
			hook_event_name: "PostToolUse",
			prompt_id: "p1",
			tool_name: tool,
			tool_input: { [key]: file },
		});
	await edit(`${h.dir}/src/a.ts`);
	await edit(`${h.dir}/src/a.ts`, "Write");
	await edit("src/b.ts", "MultiEdit");
	await edit(`${h.dir}/n.ipynb`, "NotebookEdit", "notebook_path");
	await edit("/etc/passwd");
	await edit("../outside.ts");
	await edit(`${h.dir}/src/c.ts`, "Read");
	// A tool use of another turn records nothing.
	await h.hook(0, {
		hook_event_name: "PostToolUse",
		prompt_id: "other",
		tool_name: "Write",
		tool_input: { file_path: `${h.dir}/late.ts` },
	});
	expect(h.view(request.attemptId)!.files).toEqual([
		"src/a.ts",
		"src/b.ts",
		"n.ipynb",
	]);

	await h.hook(0, {
		hook_event_name: "Notification",
		prompt_id: "p1",
		notification_type: "idle_prompt",
	});
	expect(h.terminals.activities()[0]!.activity).toBe("working");
	await h.hook(0, {
		hook_event_name: "Notification",
		prompt_id: "p1",
		notification_type: "permission_prompt",
	});
	await h.hook(0, {
		hook_event_name: "Notification",
		prompt_id: "p1",
		notification_type: "elicitation_dialog",
	});
	expect(h.terminals.activities()[0]!.activity).toBe("waiting");
	expect(waiting).toEqual([
		{ attemptId: request.attemptId, owner: "kanban:card-1" },
	]);
	await edit(`${h.dir}/src/d.ts`);
	expect(h.terminals.activities()[0]!.activity).toBe("working");

	await h.hook(0, {
		hook_event_name: "Stop",
		prompt_id: "p1",
		last_assistant_message: "あ".repeat(5000),
	});
	expect(inTransaction).toBe(true);
	expect(finished).toHaveLength(1);
	expect(finished[0]).toMatchObject({
		attemptId: request.attemptId,
		state: "completed",
		owner: "kanban:card-1",
		origin: "board",
		task: "A",
		files: ["src/a.ts", "src/b.ts", "n.ipynb", "src/d.ts"],
	});
	expect(finished[0]!.lastReport).toHaveLength(4000);
	expect(h.view(request.attemptId)).toMatchObject({
		state: "completed",
		files: finished[0]!.files,
	});
	expect(h.terminals.activities()[0]!.activity).toBe("idle");
});

test("changed files are deduplicated and capped at 200", async () => {
	const h = make();
	const request = await h.enqueue({ prompt: "多数" });
	await h.begin(0, "p", "多数");
	for (let i = 0; i < 230; i++)
		await h.hook(0, {
			hook_event_name: "PostToolUse",
			prompt_id: "p",
			tool_name: "Write",
			tool_input: { file_path: `f${i % 220}.ts` },
		});
	expect(h.view(request.attemptId)!.files).toHaveLength(200);
});

test("a late or repeated Stop of an earlier turn never finishes the next request of the conversation", async () => {
	const h = make();
	const a = await h.enqueue({ prompt: "A をして", task: "A" });
	await h.begin(0, "pa", "A をして");
	await h.hook(0, {
		hook_event_name: "Stop",
		prompt_id: "pa",
		last_assistant_message: "A 完了",
	});
	expect(h.state(a.attemptId)).toBe("completed");
	// B follows in the same conversation (the PTY is alive and idle).
	const b = await h.enqueue({
		target: "conversation",
		claudeSessionId: h.spawned[0]!.claudeId,
		prompt: "B を追加で",
		task: "B",
	});
	expect(h.spawned).toHaveLength(1);
	expect(h.spawned[0]!.writes[0]).toBe("\x1b[200~B を追加で\x1b[201~");
	await h.hook(0, {
		hook_event_name: "UserPromptSubmit",
		prompt_id: "pb",
		prompt: "B を追加で",
	});
	await h.hook(0, {
		hook_event_name: "Stop",
		prompt_id: "pa",
		last_assistant_message: "A 再送",
	});
	await h.hook(0, {
		hook_event_name: "Stop",
		prompt_id: "pa",
		last_assistant_message: "A 再送",
	});
	expect(h.state(b.attemptId)).toBe("started");
	expect(h.view(a.attemptId)!.lastReport).toBe("A 完了");
	await h.hook(0, {
		hook_event_name: "Stop",
		prompt_id: "pb",
		last_assistant_message: "B 完了",
	});
	expect(h.view(b.attemptId)).toMatchObject({
		state: "completed",
		lastReport: "B 完了",
	});
});

test("hooks of another conversation, a wrong token, or an ended run change nothing", async () => {
	const h = make();
	const request = await h.enqueue({ prompt: "x" });
	const spawned = h.spawned[0]!;
	await h.hook(0, { hook_event_name: "SessionStart" });
	await h.hook(0, {
		hook_event_name: "UserPromptSubmit",
		session_id: crypto.randomUUID(),
		prompt_id: "p",
		prompt: "x",
	});
	expect(h.state(request.attemptId)).toBe("delivered");
	await expect(
		h.terminals.hook(spawned.sessionId!, "0".repeat(64), {
			hook_event_name: "Stop",
		}),
	).rejects.toThrow("terminal_hook_forbidden");
	spawned.exit(0);
	await until(() => h.state(request.attemptId) === "ended");
	await expect(
		h.terminals.hook(spawned.sessionId!, spawned.token!, {
			hook_event_name: "Stop",
		}),
	).rejects.toThrow("terminal_hook_forbidden");
});

test("a turn that begins without a Stop of the request interrupts it", async () => {
	const h = make();
	const request = await h.enqueue({ prompt: "A" });
	await h.begin(0, "pa", "A");
	await h.hook(0, {
		hook_event_name: "UserPromptSubmit",
		prompt_id: "pz",
		prompt: "Esc の後の入力",
	});
	expect(h.view(request.attemptId)).toMatchObject({
		state: "interrupted",
		promptId: "pa",
	});
	// The stale Stop of the interrupted turn finds nothing to finish.
	await h.hook(0, { hook_event_name: "Stop", prompt_id: "pa" });
	expect(h.state(request.attemptId)).toBe("interrupted");
});

test("the request is queued while a request is on the PTY and a person is typing, and sent after the quiet time", async () => {
	const h = make({ manualInputWaitMs: 60 });
	const first = await h.enqueue({
		owner: "direct",
		target: "current",
		exclusiveGroup: undefined,
		prompt: "一件目",
		task: "一",
	});
	await h.begin(0, "p1", "一件目");
	const second = await h.enqueue({
		owner: "direct",
		target: "current",
		exclusiveGroup: undefined,
		prompt: "二件目",
		task: "二",
	});
	// One request per PTY: the second waits for the first.
	expect(h.state(second.attemptId)).toBe("queued");
	await h.hook(0, {
		hook_event_name: "Stop",
		prompt_id: "p1",
		last_assistant_message: "ok",
	});
	await until(() => h.state(second.attemptId) === "delivered");
	await until(() => h.spawned[0]!.writes.length === 2);
	expect(h.spawned[0]!.writes).toEqual(["\x1b[200~二件目\x1b[201~", "\r"]);
	expect(h.state(first.attemptId)).toBe("completed");
	await h.hook(0, {
		hook_event_name: "UserPromptSubmit",
		prompt_id: "p2",
		prompt: "二件目",
	});
	await h.hook(0, { hook_event_name: "Stop", prompt_id: "p2" });

	// The person types: a request waits until the quiet time has passed.
	h.terminals.input(h.spawned[0]!.sessionId!, "ls");
	const third = await h.enqueue({
		owner: "direct",
		target: "current",
		exclusiveGroup: undefined,
		prompt: "三件目",
		task: "三",
	});
	expect(h.state(third.attemptId)).toBe("queued");
	await until(() => h.state(third.attemptId) === "delivered");
	expect(h.spawned).toHaveLength(1);
});
