import { expect, test } from "bun:test";
import {
	clock,
	connect,
	makeCommand,
	memoryDb,
	reportOf,
	services,
} from "./support";

const lease = "6f1c2a52-6a0a-4f0d-9a39-0c9e8c7f2b11";
function setup(change: Parameters<typeof makeCommand>[0] = {}) {
	const db = memoryDb();
	const time = clock();
	const s = services(db, time.now);
	connect(db);
	connect(db, "other");
	const command = makeCommand({ leaseId: lease, state: "claimed", ...change });
	s.repo.putCommand(db, command);
	const adopted: string[] = [];
	const append = (raw: unknown, owner = "conn") =>
		s.inbox.appendInTransaction(db, owner, raw, (r) => {
			adopted.push(r.reportId);
			return { adopted: r.reportId };
		});
	return { db, time, command, append, adopted, ...s };
}
const session = (threadId = "thread-1") => ({
	threadId,
	projectId: "project",
	hostId: "local",
});

test("an accepted report is adopted once, stored and receipted", () => {
	const { db, command, append, adopted, repo } = setup();
	const raw = reportOf(command, 1, "accepted");
	const receipt = append(raw);
	expect(receipt).toEqual({ adopted: raw.reportId });
	expect(adopted).toEqual([raw.reportId]);
	expect(repo.lastSequence(db, "task-1")).toBe(1);
	expect(repo.command(db, "cmd-1")?.state).toBe("reported");
	// An exact replay returns the stored receipt without adopting again.
	expect(append(raw)).toEqual(receipt);
	expect(adopted).toHaveLength(1);
});

test("a progress report keeps the command open while other kinds close it", () => {
	const { db, command, append, repo } = setup();
	append(reportOf(command, 1, "progress"));
	expect(repo.command(db, "cmd-1")?.state).toBe("claimed");
	append(reportOf(command, 2, "completed"));
	expect(repo.command(db, "cmd-1")?.state).toBe("reported");
});

test("only the owning connection may report for a command and its task", () => {
	const { command, append } = setup();
	expect(() => append(reportOf(command, 1, "accepted"), "other")).toThrow(
		"dots_permission_denied",
	);
	expect(() =>
		append(reportOf({ ...command, taskId: "task-9" }, 1, "accepted")),
	).toThrow("dots_permission_denied");
	expect(() =>
		append(reportOf({ ...command, commandId: "nope" }, 1, "accepted")),
	).toThrow("dots_permission_denied");
});

test("a replay with different content or another task is a conflict", () => {
	const { command, append } = setup();
	const raw = reportOf(command, 1, "progress");
	append(raw);
	expect(() => append({ ...raw, summary: "別の内容" })).toThrow(
		"dots_conflict",
	);
});

test("stale epochs, leases and expiry are refused", () => {
	const unleased = setup({ leaseId: null });
	expect(() =>
		unleased.append(reportOf(unleased.command, 1, "accepted")),
	).toThrow("dots_stale");
	const expired = setup();
	expired.time.state.now = 3_000_000;
	expect(() =>
		expired.append(reportOf(expired.command, 1, "accepted")),
	).toThrow("dots_stale");
	const superseded = setup({ state: "superseded" });
	expect(() =>
		superseded.append(reportOf(superseded.command, 1, "accepted")),
	).toThrow("dots_stale");
	const epoch = setup();
	expect(() =>
		epoch.append({
			...reportOf(epoch.command, 1, "accepted"),
			authorityEpoch: 2,
		}),
	).toThrow("dots_stale");
	expect(() =>
		epoch.append({
			...reportOf(epoch.command, 1, "accepted"),
			executionGeneration: 2,
		}),
	).toThrow("dots_stale");
});

test("report sequences must be consecutive per task", () => {
	const { command, append } = setup();
	expect(() => append(reportOf(command, 2, "progress"))).toThrow(
		"dots_sequence_gap",
	);
	append(reportOf(command, 1, "progress"));
	expect(() => append(reportOf(command, 1, "progress"))).toThrow(
		"dots_sequence_gap",
	);
	expect(() => append(reportOf(command, 3, "progress"))).toThrow(
		"dots_sequence_gap",
	);
	append(reportOf(command, 2, "progress"));
});

test("an invalid report shape is rejected before any state is read", () => {
	const { command, append, adopted } = setup();
	for (const bad of [
		{ summary: "" },
		{ kind: "unknown" },
		{ sourceSequence: 0 },
		{ extra: 1 },
		{ reportId: "not-a-uuid" },
	])
		expect(() =>
			append({ ...reportOf(command, 1, "progress"), ...bad }),
		).toThrow();
	expect(adopted).toEqual([]);
});

test("progress reports are capped at 1000 per task but a stop is still accepted", () => {
	const { db, command, append } = setup();
	const insert = db.query("INSERT INTO dots_reports VALUES(?,?,?,?,?,?)");
	db.transaction(() => {
		for (let i = 1; i <= 1000; i++)
			insert.run(
				`r${i}`,
				"task-1",
				i,
				"d",
				JSON.stringify({ kind: "progress" }),
				"{}",
			);
	})();
	expect(() => append(reportOf(command, 1001, "progress"))).toThrow(
		"dots_capacity",
	);
	append(reportOf(command, 1001, "stopped"));
});

test("a stopped report is stored without its details but keeps the session association", () => {
	const { db, command, append } = setup();
	append(
		reportOf(command, 1, "stopped", {
			facts: ["内部の事実"],
			limitations: ["制約"],
			evidenceRefs: ["ev-1"],
			sessions: [session()],
			question: {
				questionId: "q",
				prompt: "質問",
				answerType: "text",
				choices: [],
			},
		}),
	);
	const stored = JSON.parse(
		(db.query("SELECT data_json d FROM dots_reports").get() as { d: string }).d,
	);
	expect(stored).toMatchObject({
		kind: "stopped",
		summary: "stop_confirmed",
		sessions: [],
		facts: [],
		limitations: [],
		evidenceRefs: [],
	});
	expect(JSON.stringify(stored)).not.toContain("内部の事実");
	// The thread association stays: it identifies native sessions the task owns.
	expect(db.query("SELECT count(*) n FROM dots_sessions").get()).toEqual({
		n: 1,
	});
});

test("sessions are associated to the task and read back by task and thread", () => {
	const { db, command, append, inbox } = setup();
	append(reportOf(command, 1, "session_started", { sessions: [session()] }));
	expect(inbox.sessionsInTransaction(db, "task-1")).toEqual([
		{ ...session(), parentThreadId: null },
	]);
	expect(inbox.sessionAssociationsInTransaction(db, "thread-1")).toEqual([
		{ taskId: "task-1", session: { ...session(), parentThreadId: null } },
	]);
	expect(inbox.sessionsInTransaction(db, "task-2")).toEqual([]);
	// Reporting the same session again is idempotent.
	append(reportOf(command, 2, "progress", { sessions: [session()] }));
	expect(inbox.sessionsInTransaction(db, "task-1")).toHaveLength(1);
	// A different description of an associated thread is a conflict.
	expect(() =>
		append(
			reportOf(command, 3, "progress", {
				sessions: [{ ...session(), hostId: "elsewhere" }],
			}),
		),
	).toThrow("dots_conflict");
});

test("a failed adoption stores nothing", () => {
	const { db, command, inbox, repo } = setup();
	expect(() =>
		db.transaction(() =>
			inbox.appendInTransaction(
				db,
				"conn",
				reportOf(command, 1, "accepted"),
				() => {
					throw new Error("adopt_failed");
				},
			),
		)(),
	).toThrow("adopt_failed");
	expect(repo.lastSequence(db, "task-1")).toBe(0);
	expect(repo.command(db, "cmd-1")?.state).toBe("claimed");
});

test("reminders require a live schedule bound to the same owner and command, once per occurrence", () => {
	const { db, time, command, append, inbox } = setup({ kind: "reminder" });
	const reminder = (occurrenceRef: string, scheduleRef = "sched") => ({
		reminder: { scheduleRef, occurrenceRef },
	});
	expect(() => append(reportOf(command, 1, "reminder"))).toThrow(
		"invalid_dots_report",
	);
	expect(() =>
		append(reportOf(command, 1, "reminder", reminder("o1"))),
	).toThrow("dots_permission_denied");
	inbox.bindScheduleInTransaction(
		db,
		"conn",
		"task-1",
		"sched",
		"cmd-1",
		time.now() + 1000,
	);
	append(reportOf(command, 1, "reminder", reminder("o1")));
	expect(() =>
		append(reportOf(command, 2, "reminder", reminder("o1"))),
	).toThrow("dots_conflict");
	append(reportOf(command, 2, "reminder", reminder("o2")));
	// Another command of the task cannot use this schedule.
	expect(() =>
		inbox.bindScheduleInTransaction(db, "other", "task-1", "sched", "cmd-1", 1),
	).toThrow("dots_conflict");
	time.state.now += 5000;
	expect(() =>
		append(reportOf(command, 3, "reminder", reminder("o3"))),
	).toThrow();
});

test("schedule binding is owned by its first task and connection and can be extended", () => {
	const { db, inbox } = setup();
	inbox.bindScheduleInTransaction(db, "conn", "task-1", "sched", "cmd-1", 10);
	inbox.bindScheduleInTransaction(db, "conn", "task-1", "sched", "cmd-2", 20);
	expect(inbox.scheduleInTransaction(db, "sched")).toEqual({
		task_id: "task-1",
		connection_ref: "conn",
		command_id: "cmd-2",
		expires_at: 20,
	});
	expect(() =>
		inbox.bindScheduleInTransaction(db, "conn", "task-2", "sched", "cmd-3", 30),
	).toThrow("dots_conflict");
	expect(inbox.scheduleInTransaction(db, "none")).toBeNull();
});

test("dialogue receipts are stored per run and read back", () => {
	const { db, inbox } = setup();
	expect(inbox.dialogueReceiptInTransaction(db, "run-1")).toBeNull();
	inbox.saveDialogueReceiptInTransaction(db, "run-1", "main", "task-1", {
		ok: true,
	});
	expect(inbox.dialogueReceiptInTransaction(db, "run-1")).toEqual({ ok: true });
	expect(() =>
		inbox.saveDialogueReceiptInTransaction(db, "run-1", "main", "task-1", {}),
	).toThrow();
});

test("projects are listed in ref order", () => {
	const { db, inbox } = setup();
	for (const ref of ["b", "a"])
		db.query("INSERT INTO dots_projects VALUES(?,?,?)").run(
			ref,
			"conn",
			JSON.stringify({ ref }),
		);
	expect(inbox.projectsInTransaction(db)).toEqual([
		{ ref: "a" },
		{ ref: "b" },
	] as never);
});
