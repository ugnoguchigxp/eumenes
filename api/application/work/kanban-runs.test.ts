import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createKanban,
	migrations as kanbanMigrations,
	type KanbanBoardView,
	WORK_ONLY_INSTRUCTION,
} from "../../domains/kanban";
import {
	createTerminals,
	migrations as terminalsMigrations,
} from "../../domains/terminals";
import type { HookPayload } from "../../domains/terminals";
import type { TerminalsOptions } from "../../domains/terminals";
import { fakePty, until } from "../../domains/terminals/test/terminals.fixture";
import { openStore, type SqliteStore } from "../../infrastructure/sqlite";
import { createKanbanAdapter } from "./kanban-adapter";
import { connectKanbanRuns, type KanbanTerminals } from "./kanban-runs";

const open: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
	for (const item of open.splice(0)) await item.close();
});

type Pty = ReturnType<typeof fakePty>;

/** Kanban over real terminals (fake PTYs) in one SQLite file: the board's run path end to end. */
function make(
	options: Partial<TerminalsOptions> = {},
	pty: Pty = fakePty(),
	restartOf?: { dir: string; store: SqliteStore },
) {
	const dir = restartOf?.dir ?? mkdtempSync(join(tmpdir(), "eumenes-runs-"));
	const store =
		restartOf?.store ??
		openStore(join(dir, "db"), [
			{ id: "queue/0001-init", sql: "CREATE TABLE queue_stub (id TEXT)" },
			...terminalsMigrations,
			...kanbanMigrations,
		]);
	const terminals = createTerminals({
		command: ["claude"],
		spawn: pty.spawn,
		store,
		hookBaseUrl: "http://127.0.0.1:8787",
		curl: "curl",
		submitDelayMs: 0,
		sweepMs: 3_600_000,
		trackingMs: 10_000,
		manualInputWaitMs: 40,
		cwd: dir,
		...options,
	});
	// Terminals dispatches nothing until its startup recovery has run.
	if (!restartOf) void terminals.recover();
	const kanban = createKanban({ store });
	let wrapped: KanbanTerminals = terminals;
	const link = connectKanbanRuns(kanban, {
		get enqueueInTransaction() {
			return wrapped.enqueueInTransaction;
		},
		cancelQueuedInTransaction: terminals.cancelQueuedInTransaction,
		requestInTransaction: terminals.requestInTransaction,
		stop: terminals.stop,
		activities: terminals.activities,
		onFinishedInTransaction: terminals.onFinishedInTransaction,
		onWaitingInTransaction: terminals.onWaitingInTransaction,
	});
	const adapter = createKanbanAdapter(kanban, {
		runnable: () => terminals.trackable(),
	});
	const origin = { kind: "ui" as const, scope: "s", actionRequestId: "a" };
	const board = () =>
		store.read(
			(tx) =>
				adapter.sourceInTransaction(tx, "query:kanban.board@1", undefined)!
					.data as KanbanBoardView,
		);
	const harness = {
		dir,
		store,
		terminals,
		kanban,
		adapter,
		pty,
		spawned: pty.spawned,
		board,
		/** Replaces what the finishing transaction uses to hand the next run over. */
		overrideEnqueue(enqueue: KanbanTerminals["enqueueInTransaction"]) {
			wrapped = { ...terminals, enqueueInTransaction: enqueue };
		},
		link,
		card: (id: string) => board().cards.find((c) => c.id === id)!,
		async act(operation: string, input: unknown) {
			const out = await store.write((tx) =>
				adapter.invokeInTransaction(tx, {
					operationName: operation,
					input,
					requestId: crypto.randomUUID(),
					issuedAt: "2026-10-14T00:00:00.000Z",
					origin,
				}),
			);
			adapter.afterCommit?.();
			await terminals.settled();
			return out.receipt as { cardId: string; runId?: string };
		},
		async add(title: string, prompt = `${title} の依頼`) {
			return (await harness.act("kanban.add", { title, prompt })).cardId;
		},
		async ref(cardId: string) {
			return { cardId, expectedRevision: harness.card(cardId).revision };
		},
		async run(cardId: string) {
			return harness.act("kanban.run", await harness.ref(cardId));
		},
		async hook(
			index: number,
			payload: Omit<HookPayload, "session_id"> & { session_id?: string },
		) {
			const spawned = pty.spawned[index]!;
			await terminals.hook(spawned.sessionId!, spawned.token!, {
				session_id: spawned.claudeId,
				...payload,
			} as HookPayload);
			await terminals.settled();
		},
		/** SessionStart and the start of the request's turn, as the real run reports them. */
		async begin(index: number, promptId: string, source = "startup") {
			const prompt = pty.spawned[index]!.command.at(-1)!;
			await harness.hook(index, {
				hook_event_name: "SessionStart",
				source,
			});
			await harness.hook(index, {
				hook_event_name: "UserPromptSubmit",
				prompt_id: promptId,
				prompt,
			});
		},
		async stop(index: number, promptId: string, report = "終わりました") {
			await harness.hook(index, {
				hook_event_name: "Stop",
				prompt_id: promptId,
				last_assistant_message: report,
			});
		},
		async close() {
			link.disconnect();
			terminals.closeAll();
			if (!restartOf) {
				await store.close().catch(() => {});
				rmSync(dir, { recursive: true, force: true });
			}
		},
	};
	open.push(harness);
	return harness;
}
type Harness = ReturnType<typeof make>;

const noticeKinds = (h: Harness) =>
	h.kanban.notices(20).notices.map((notice) => notice.kind);

test("three runs: one is handed at a time; the next goes in the transaction that ends the one before", async () => {
	const h = make();
	const [a, b, c] = [await h.add("A"), await h.add("B"), await h.add("C")];
	const ra = await h.run(a!);
	await h.run(b!);
	await h.run(c!);
	// Only the first reached terminals; the others wait on the board.
	expect(h.spawned).toHaveLength(1);
	expect(h.board().queue).toMatchObject({ state: "running", waiting: 2 });
	expect(h.terminals.list().requests).toBe(0);
	expect(h.spawned[0]!.command.at(-1)).toBe(
		`A の依頼\n\n${WORK_ONLY_INSTRUCTION}`,
	);
	expect(h.board().runs[0]).toMatchObject({ requestState: "delivered" });

	await h.begin(0, "p1");
	expect(h.board().runs[0]).toMatchObject({
		requestState: "started",
		activity: "working",
	});
	await h.stop(0, "p1", "A を直しました");
	await until(() => h.spawned.length === 2);
	expect(h.card(a!)).toMatchObject({
		label: "done",
		lastReport: "A を直しました",
	});
	expect(h.board().runs.find((r) => r.id === ra.runId)).toMatchObject({
		state: "completed",
	});
	expect(h.board().queue).toMatchObject({ waiting: 1 });
	expect(h.spawned[1]!.command.at(-1)).toContain("B の依頼");
	expect(noticeKinds(h)).toEqual(["done"]);
});

test("five and more tasks run one after another, each in its own conversation, within the process limit", async () => {
	const h = make({ limit: 4 });
	const ids: string[] = [];
	for (let i = 1; i <= 6; i++) ids.push(await h.add(`T${i}`));
	for (const id of ids) await h.run(id);
	for (let i = 0; i < 6; i++) {
		await until(() => h.spawned.length === i + 1);
		await h.begin(i, `p${i}`);
		await h.stop(i, `p${i}`, `T${i + 1} 完了`);
	}
	await until(() => h.card(ids[5]!).label === "done");
	expect(new Set(h.spawned.map((s) => s.claudeId)).size).toBe(6);
	expect(ids.map((id) => h.card(id).label)).toEqual(Array(6).fill("done"));
	// Idle Kanban sessions were closed to make room: never more than four live.
	expect(
		h.terminals.list().sessions.filter((s) => s.status === "running").length,
	).toBeLessThanOrEqual(4);
	expect(noticeKinds(h).filter((k) => k === "done")).toHaveLength(6);
	expect(h.board().queue).toMatchObject({ state: "running", waiting: 0 });
});

test("an interrupted run is a Blocker and the next one still goes", async () => {
	const h = make();
	const a = await h.add("A");
	const b = await h.add("B");
	await h.run(a);
	await h.run(b);
	await h.begin(0, "p1");
	// A different turn begins without A's Stop: A was interrupted.
	await h.hook(0, {
		hook_event_name: "UserPromptSubmit",
		prompt_id: "other",
		prompt: "手で打った",
	});
	expect(h.card(a)).toMatchObject({ label: "blocker", reason: "interrupted" });
	expect(noticeKinds(h)).toEqual(["blocker"]);
	// B is handed over but waits for the manually typed turn on the Kanban session to end.
	expect(h.board().queue.handedRunId).toBe(h.card(b).currentRunId);
	expect(h.spawned).toHaveLength(1);
	await h.hook(0, { hook_event_name: "Stop", prompt_id: "other" });
	await until(() => h.spawned.length === 2);
});

test("stopping a run waits for the process to end; then it is a Blocker and the next one starts", async () => {
	const h = make();
	const a = await h.add("A");
	const b = await h.add("B");
	await h.run(a);
	await h.run(b);
	await h.begin(0, "p1");
	await h.act("kanban.stop", await h.ref(a));
	await until(() => h.card(a).label === "blocker");
	expect(h.spawned[0]!.signals).toEqual(["SIGTERM"]);
	expect(h.card(a)).toMatchObject({ reason: "stopped_by_person" });
	await until(() => h.spawned.length === 2);
	expect(h.spawned[1]!.command.at(-1)).toContain("B の依頼");
	// The person's own stop is not announced.
	expect(noticeKinds(h)).toEqual([]);
});

test("a stop that cannot be confirmed pauses the queue and keeps the card running", async () => {
	const h = make(
		{ killAfterMs: 20, stopConfirmMs: 80 },
		fakePty({ ignore: ["SIGTERM", "SIGKILL"] }),
	);
	const a = await h.add("A");
	const b = await h.add("B");
	await h.run(a);
	await h.run(b);
	await h.begin(0, "p1");
	await h.act("kanban.stop", await h.ref(a));
	await until(() => h.board().queue.state === "paused");
	expect(h.board().queue).toMatchObject({
		reason: "stop_unconfirmed",
		handedRunId: h.card(a).currentRunId,
	});
	expect(h.card(a).column).toBe("running");
	// The follow-up of an unconfirmed card is refused, and B does not start.
	expect(h.spawned).toHaveLength(1);
	expect(noticeKinds(h)).toEqual(["queue_paused"]);
	// The process finally ends: A is a Blocker but the queue stays stopped until resumed.
	h.spawned[0]!.exit(0);
	await until(() => h.card(a).label === "blocker");
	expect(h.card(a).reason).toBe("ended");
	expect(h.spawned).toHaveLength(1);
	await h.act("kanban.resume-queue", {});
	await until(() => h.spawned.length === 2);
	expect(h.board().queue.state).toBe("running");
});

test("a finish the board could not write is settled from the request: the card is Done and the next run goes", async () => {
	const h = make();
	const a = await h.add("A");
	const b = await h.add("B");
	await h.run(a);
	await h.run(b);
	await h.begin(0, "p1");
	// The board's part of the finishing transaction fails once; terminals' final state stays.
	const real = h.kanban.finishRunInTransaction;
	let failures = 0;
	h.kanban.finishRunInTransaction = (tx, finish) => {
		if (failures++ === 0) throw new Error("boom");
		return real(tx, finish);
	};
	await h.stop(0, "p1", "A を直しました");
	await until(() => h.card(a).label === "done");
	expect(h.card(a)).toMatchObject({ lastReport: "A を直しました" });
	await until(() => h.spawned.length === 2);
	expect(h.spawned[1]!.command.at(-1)).toContain("B の依頼");
	expect(noticeKinds(h)).toEqual(["done"]);
});

test("hooks that never arrive make a Blocker, stop the queue and announce both", async () => {
	const h = make({ trackingMs: 40 });
	const a = await h.add("A");
	const b = await h.add("B");
	await h.run(a);
	await h.run(b);
	await until(() => h.card(a).label === "blocker");
	expect(h.card(a).reason).toBe("tracking_lost");
	expect(h.board().queue).toMatchObject({
		state: "paused",
		reason: "tracking_lost",
		waiting: 1,
	});
	expect(h.spawned).toHaveLength(1);
	expect(noticeKinds(h).sort()).toEqual(["blocker", "queue_paused"]);
});

test("a run waiting for permission is announced once", async () => {
	const h = make();
	const a = await h.add("A");
	await h.run(a);
	await h.begin(0, "p1");
	const ask = () =>
		h.hook(0, {
			hook_event_name: "Notification",
			notification_type: "permission_prompt",
			prompt_id: "p1",
		} as never);
	await ask();
	expect(h.board().runs[0]).toMatchObject({ activity: "waiting" });
	await h.hook(0, {
		hook_event_name: "PostToolUse",
		prompt_id: "p1",
		tool_name: "Write",
		tool_input: { file_path: `${h.dir}/src/a.ts` },
	} as never);
	await ask();
	expect(noticeKinds(h)).toEqual(["waiting"]);
	await h.hook(0, { hook_event_name: "Stop", prompt_id: "p1" });
	expect(h.card(a)).toMatchObject({ label: "done", files: ["src/a.ts"] });
	expect(noticeKinds(h)).toEqual(["done", "waiting"]);
});

test("git is refused in work mode whatever the card says; commit & push resumes the conversation without the refusal", async () => {
	const h = make();
	const a = await h.add("A", "修正して commit・push まで");
	await h.run(a);
	const work = h.spawned[0]!;
	expect(work.settings?.permissions?.deny).toEqual([
		"Bash(git commit *)",
		"Bash(git push *)",
	]);
	expect(work.command.at(-1)).toContain("修正して commit・push まで");
	expect(work.command.at(-1)!.endsWith(WORK_ONLY_INSTRUCTION)).toBe(true);
	await h.begin(0, "p1");
	await h.hook(0, {
		hook_event_name: "PostToolUse",
		prompt_id: "p1",
		tool_name: "Edit",
		tool_input: { file_path: `${h.dir}/x.ts` },
	} as never);
	await h.stop(0, "p1");

	// A note that asks for a commit is a work-mode follow-up too: the live idle session of the
	// conversation takes it, and that session already refuses git.
	await h.act("kanban.followup", { ...(await h.ref(a)), note: "commit して" });
	expect(h.spawned).toHaveLength(1);
	expect(work.writes[0]).toContain("commit して");
	expect(work.writes[0]).toContain(WORK_ONLY_INSTRUCTION);
	expect(h.card(a).column).toBe("running");
});

test("commit & push closes the idle work session and resumes the same conversation in commit mode", async () => {
	const h = make();
	const a = await h.add("A");
	await h.run(a);
	const claudeId = h.spawned[0]!.claudeId;
	await h.begin(0, "p1");
	await h.hook(0, {
		hook_event_name: "PostToolUse",
		prompt_id: "p1",
		tool_name: "Write",
		tool_input: { file_path: `${h.dir}/note.md` },
	} as never);
	await h.stop(0, "p1");
	expect(h.card(a)).toMatchObject({ label: "done", files: ["note.md"] });
	await h.act("kanban.commit-push", await h.ref(a));
	await until(() => h.spawned.length === 2);
	const commit = h.spawned[1]!;
	expect(commit.command.slice(0, 3)).toEqual(["claude", "--resume", claudeId]);
	expect(commit.settings?.permissions).toBeUndefined();
	expect(commit.command.at(-1)).toContain('["note.md"]');
	expect(
		h.spawned[0]!.killed ||
			h.spawned[0]!.signals.length > 0 ||
			h.spawned[0]!.closed,
	).toBe(true);
	await h.begin(1, "c1", "resume");
	await h.stop(1, "c1", "push しました");
	expect(h.card(a)).toMatchObject({
		label: "done",
		commitPushReported: true,
		lastReport: "push しました",
		files: ["note.md"],
	});
	expect(noticeKinds(h)).toEqual(["commit_push", "done"]);
	// The next follow-up is back in work mode, again with the refusal.
	await h.act("kanban.followup", { ...(await h.ref(a)), note: "もう一点" });
	await until(() => h.spawned.length === 3);
	expect(h.spawned[2]!.command.slice(0, 3)).toEqual([
		"claude",
		"--resume",
		claudeId,
	]);
	expect(h.spawned[2]!.settings?.permissions?.deny).toBeDefined();
});

test("after a restart the sent run is a Blocker, the queue is stopped, and a follow-up resumes the conversation", async () => {
	const first = make();
	const a = await first.add("A");
	const b = await first.add("B");
	const c = await first.add("C");
	await first.run(a);
	await first.run(b);
	await first.begin(0, "p1");
	const doneRun = await first.run(c);
	expect(doneRun.runId).toBeDefined();
	const claudeId = first.spawned[0]!.claudeId;
	const { store, dir } = first;
	// The old process is gone; the database is what is left.
	first.link.disconnect();
	first.terminals.closeAll();
	const second = make({}, fakePty(), { dir, store });
	await second.terminals.recover();
	await second.link.recover();
	expect(second.card(a)).toMatchObject({
		label: "blocker",
		reason: "restarted",
	});
	expect(second.board().queue).toMatchObject({
		state: "paused",
		reason: "restarted",
		waiting: 2,
	});
	expect(second.spawned).toHaveLength(0);
	expect(noticeKinds(second).sort()).toEqual(["blocker", "queue_paused"]);
	// The conversation is on disk: a follow-up resumes it. It queues behind B and C, which were
	// waiting before it, and nothing is sent while the queue is stopped.
	await second.act("kanban.followup", {
		...(await second.ref(a)),
		note: "続きを直して",
	});
	expect(second.spawned).toHaveLength(0);
	await second.act("kanban.resume-queue", {});
	await until(() => second.spawned.length === 1);
	expect(second.spawned[0]!.command[1]).toBe("--session-id");
	expect(second.spawned[0]!.command.at(-1)).toContain("B の依頼");
	await second.begin(0, "b1");
	await second.stop(0, "b1");
	await until(() => second.spawned.length === 2);
	await second.begin(1, "c1");
	await second.stop(1, "c1");
	await until(() => second.spawned.length === 3);
	expect(second.spawned[2]!.command.slice(0, 3)).toEqual([
		"claude",
		"--resume",
		claudeId,
	]);
	expect(second.spawned[2]!.command.at(-1)).toContain("続きを直して");
	await second.begin(2, "a2", "resume");
	await second.stop(2, "a2", "続きを直しました");
	expect(second.card(a)).toMatchObject({
		label: "done",
		lastReport: "続きを直しました",
	});
});

test("recovery that runs after terminals' own settles handed runs from their requests", async () => {
	const first = make();
	const a = await first.add("A");
	const b = await first.add("B");
	await first.run(a);
	await first.run(b);
	await first.begin(0, "p1");
	const { store, dir } = first;
	first.link.disconnect();
	first.terminals.closeAll();
	// Terminals recovers before the board is connected: the listener was not there to hear it.
	const terminals = createTerminals({
		command: ["claude"],
		spawn: fakePty().spawn,
		store,
		hookBaseUrl: "http://127.0.0.1:8787",
		curl: "curl",
		cwd: dir,
	});
	await terminals.recover();
	const kanban = createKanban({ store });
	expect(kanban.board({ runnable: true }).cards[0]!.column).toBe("running");
	const link = connectKanbanRuns(kanban, terminals);
	await link.recover();
	const board = kanban.board({ runnable: true });
	expect(board.cards.find((c) => c.id === a)).toMatchObject({
		label: "blocker",
		reason: "restarted",
	});
	expect(board.queue).toMatchObject({ state: "paused", reason: "restarted" });
	link.disconnect();
	terminals.closeAll();
});

test("when the next run cannot be handed over, the finished one stays final, the next is blocked and the queue stops", async () => {
	const h = make();
	const a = await h.add("A");
	const b = await h.add("B");
	await h.run(a);
	await h.run(b);
	await h.begin(0, "p1");
	h.overrideEnqueue(() => {
		throw new Error("terminal_tracking_unavailable");
	});
	await h.stop(0, "p1");
	expect(h.card(a)).toMatchObject({ label: "done" });
	expect(h.card(b)).toMatchObject({ label: "blocker", reason: "send_failed" });
	expect(h.board().queue).toMatchObject({
		state: "paused",
		reason: "tracking_lost",
	});
	expect(h.terminals.activities()[0]!.activity).toBe("idle");
});

test("direct requests do not touch the board", async () => {
	const h = make();
	const a = await h.add("A");
	await h.store.write((tx) =>
		h.terminals.enqueueInTransaction(tx, {
			attemptId: crypto.randomUUID(),
			owner: "direct",
			target: "current",
			mode: "work",
			projectId: "eumenes",
			prompt: "直接の依頼",
			task: "直接",
			origin: "board",
		}),
	);
	await h.terminals.settled();
	await h.begin(0, "d1");
	await h.stop(0, "d1");
	expect(h.card(a).column).toBe("todo");
	expect(noticeKinds(h)).toEqual([]);
	expect(h.board().runs).toEqual([]);
});

test("the sent text is fixed when the run is created; a waiting card cannot be edited", async () => {
	const h = make();
	const a = await h.add("A");
	const b = await h.add("B");
	await h.run(a);
	await h.run(b);
	await expect(
		h.act("kanban.edit", { ...(await h.ref(b)), prompt: "ここは送られない" }),
	).rejects.toThrow("kanban_card_busy");
	await h.begin(0, "p1");
	await h.stop(0, "p1");
	await until(() => h.spawned.length === 2);
	expect(h.spawned[1]!.command.at(-1)).toContain("B の依頼");
});
