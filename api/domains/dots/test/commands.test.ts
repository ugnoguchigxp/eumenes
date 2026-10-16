import { expect, test } from "bun:test";
import { clock, connect, makeCommand, memoryDb, services } from "./support";

const lease = "6f1c2a52-6a0a-4f0d-9a39-0c9e8c7f2b11";
const otherLease = "0b6b4d8e-5b0e-4a62-8a9f-3f5c1d0a7e22";
function setup() {
	const db = memoryDb();
	const time = clock();
	const s = services(db, time.now);
	connect(db);
	connect(db, "other");
	return { db, time, ...s };
}

test("prepare stores a command once and rejects a different task or kind under the same id", () => {
	const { db, commands, repo } = setup();
	const c = makeCommand();
	expect(commands.prepareInTransaction(db, c)).toEqual(c);
	expect(commands.prepareInTransaction(db, { ...c, expiresAt: 5 })).toEqual(c);
	expect(() =>
		commands.prepareInTransaction(db, { ...c, taskId: "other-task" }),
	).toThrow("dots_conflict");
	expect(() =>
		commands.prepareInTransaction(db, { ...c, kind: "answer" }),
	).toThrow("dots_conflict");
	expect(repo.taskCommands(db, "task-1")).toHaveLength(1);
});

test("capacity leaves room for stop commands", () => {
	const { db, commands } = setup();
	const insert = db.query(
		"INSERT INTO dots_commands(id,task_id,connection_ref,state,data_json) VALUES(?,?,?,?,?)",
	);
	db.transaction(() => {
		for (let i = 0; i < 3840; i++)
			insert.run(`filler-${i}`, "t", "conn", "pending", "{}");
	})();
	expect(() =>
		commands.prepareInTransaction(db, makeCommand({ commandId: "late" })),
	).toThrow("dots_capacity");
	expect(
		commands.prepareInTransaction(
			db,
			makeCommand({ commandId: "stop-1", kind: "stop" }),
		).commandId,
	).toBe("stop-1");
});

test("list returns only live commands of the owner, pages by cursor and validates its bounds", () => {
	const { db, time, commands } = setup();
	for (let i = 1; i <= 4; i++)
		commands.prepareInTransaction(
			db,
			makeCommand({ commandId: `c${i}`, taskId: `t${i}` }),
		);
	commands.prepareInTransaction(
		db,
		makeCommand({ commandId: "expired", expiresAt: time.now() + 1 }),
	);
	commands.prepareInTransaction(
		db,
		makeCommand({ commandId: "foreign", connectionRef: "other" }),
	);
	commands.prepareInTransaction(
		db,
		makeCommand({ commandId: "done", state: "reported" }),
	);
	time.state.now += 10;
	const first = commands.list("conn", 0, 2);
	expect(first.items.map((i) => i.commandId)).toEqual(["c1", "c2"]);
	expect(first.nextCursor).not.toBeNull();
	const second = commands.list("conn", first.nextCursor!, 2);
	expect(second.items.map((i) => i.commandId)).toEqual(["c3", "c4"]);
	const rest = commands.list("conn", second.nextCursor!, 2);
	expect(rest.items.map((i) => i.commandId)).toEqual([]);
	expect(rest.nextCursor).toBeNull();
	expect(commands.list("other").items.map((i) => i.commandId)).toEqual([
		"foreign",
	]);
	for (const [after, limit] of [
		[-1, 10],
		[0, 0],
		[0, 101],
		[1.5, 10],
		[0, 1.5],
	] as const)
		expect(() => commands.list("conn", after, limit)).toThrow(
			"invalid_dots_cursor",
		);
});

test("get enforces ownership, availability and expiry", () => {
	const { db, time, commands } = setup();
	connect(db, "off", { enabled: false });
	commands.prepareInTransaction(db, makeCommand());
	commands.prepareInTransaction(
		db,
		makeCommand({ commandId: "off-start", connectionRef: "off" }),
	);
	commands.prepareInTransaction(
		db,
		makeCommand({ commandId: "off-stop", connectionRef: "off", kind: "stop" }),
	);
	expect(commands.getInTransaction(db, "conn", "cmd-1").commandId).toBe(
		"cmd-1",
	);
	expect(() => commands.getInTransaction(db, "other", "cmd-1")).toThrow(
		"dots_permission_denied",
	);
	expect(() => commands.getInTransaction(db, "conn", "missing")).toThrow(
		"dots_not_found",
	);
	expect(() => commands.getInTransaction(db, "off", "off-start")).toThrow(
		"dots_unavailable",
	);
	// A stop must stay reachable on a disabled connection.
	expect(commands.getInTransaction(db, "off", "off-stop").kind).toBe("stop");
	time.state.now = 3_000_000;
	expect(() => commands.getInTransaction(db, "conn", "cmd-1")).toThrow(
		"dots_stale",
	);
});

test("claim binds one lease, is repeatable for the same lease and refuses another", async () => {
	const { db, commands, repo } = setup();
	commands.prepareInTransaction(db, makeCommand());
	const claimed = await commands.claim("conn", {
		commandId: "cmd-1",
		leaseId: lease,
	});
	expect(claimed).toEqual({
		commandId: "cmd-1",
		leaseId: lease,
		expiresAt: 2_000_000,
	});
	expect(repo.command(db, "cmd-1")).toMatchObject({
		state: "claimed",
		leaseId: lease,
	});
	expect(
		await commands.claim("conn", { commandId: "cmd-1", leaseId: lease }),
	).toEqual(claimed);
	await expect(
		commands.claim("conn", { commandId: "cmd-1", leaseId: otherLease }),
	).rejects.toThrow("dots_conflict");
	await expect(
		commands.claim("other", { commandId: "cmd-1", leaseId: lease }),
	).rejects.toThrow("dots_permission_denied");
	await expect(
		commands.claim("conn", { commandId: "cmd-1", leaseId: "not-a-uuid" }),
	).rejects.toThrow();
	await expect(
		commands.claim("conn", { commandId: "missing", leaseId: lease }),
	).rejects.toThrow("dots_not_found");
});

test("claim runs the caller's validation and refuses reported commands except reminders", async () => {
	const { db, commands } = setup();
	commands.prepareInTransaction(db, makeCommand({ state: "reported" }));
	commands.prepareInTransaction(
		db,
		makeCommand({ commandId: "rem", kind: "reminder", state: "reported" }),
	);
	await expect(
		commands.claim("conn", { commandId: "cmd-1", leaseId: lease }),
	).rejects.toThrow("dots_stale");
	expect(
		(await commands.claim("conn", { commandId: "rem", leaseId: lease }))
			.leaseId,
	).toBe(lease);
	commands.prepareInTransaction(
		db,
		makeCommand({ commandId: "v", taskId: "tv" }),
	);
	await expect(
		commands.claim("conn", { commandId: "v", leaseId: lease }, () => {
			throw new Error("dots_permission_denied");
		}),
	).rejects.toThrow("dots_permission_denied");
	expect(
		db.query("SELECT state FROM dots_commands WHERE id='v'").get(),
	).toEqual({
		state: "pending",
	});
});

test("supersede ends a task's commands, optionally keeping reminders", () => {
	const { db, commands, repo } = setup();
	commands.prepareInTransaction(db, makeCommand());
	commands.prepareInTransaction(
		db,
		makeCommand({ commandId: "rem", kind: "reminder" }),
	);
	commands.prepareInTransaction(
		db,
		makeCommand({ commandId: "other", taskId: "task-2" }),
	);
	commands.supersedeInTransaction(db, "task-1", true);
	expect(repo.command(db, "cmd-1")?.state).toBe("superseded");
	expect(repo.command(db, "rem")?.state).toBe("pending");
	expect(repo.command(db, "other")?.state).toBe("pending");
	commands.supersedeInTransaction(db, "task-1");
	expect(repo.command(db, "rem")?.state).toBe("superseded");
});

test("redaction strips snapshots, keeps stop intent and removes reports", () => {
	const { db, commands, repo } = setup();
	const snapshot = {
		protocolVersion: 1,
		task: { id: "task-1", request: "秘密の依頼", stopIntent: "cancel" },
		project: { ref: "p" },
		sessions: [{ threadId: "s" }],
	};
	commands.prepareInTransaction(db, makeCommand({ snapshot }));
	commands.prepareInTransaction(
		db,
		makeCommand({ commandId: "stop", kind: "stop", snapshot }),
	);
	db.query(
		"INSERT INTO dots_dialogue_receipts VALUES('run','main','task-1','{}')",
	).run();
	commands.redactInTransaction(db, "task-1");
	const start = repo.command(db, "cmd-1")!;
	expect(start.state).toBe("superseded");
	expect(start.snapshot).toEqual({
		protocolVersion: 1,
		task: { id: "task-1" },
		project: { ref: "p" },
		sessions: [{ threadId: "s" }],
	});
	const stop = repo.command(db, "stop")!;
	expect(stop.state).toBe("pending");
	expect(stop.snapshot.task).toEqual({ id: "task-1", stopIntent: "cancel" });
	expect(JSON.stringify([start, stop])).not.toContain("秘密の依頼");
	expect(
		db.query("SELECT count(*) n FROM dots_dialogue_receipts").get(),
	).toEqual({ n: 0 });
});

test("renewing a stop extends it for a day and refuses other commands", () => {
	const { db, time, commands } = setup();
	commands.prepareInTransaction(
		db,
		makeCommand({ commandId: "stop", kind: "stop" }),
	);
	commands.prepareInTransaction(db, makeCommand());
	time.state.now = 1_500_000;
	expect(commands.renewStopInTransaction(db, "stop").expiresAt).toBe(
		1_500_000 + 86_400_000,
	);
	expect(() => commands.renewStopInTransaction(db, "cmd-1")).toThrow(
		"dots_stale",
	);
	expect(() => commands.renewStopInTransaction(db, "missing")).toThrow(
		"dots_stale",
	);
	commands.supersedeInTransaction(db, "task-1");
	expect(() => commands.renewStopInTransaction(db, "stop")).toThrow(
		"dots_stale",
	);
});

test("purge removes every record of a task and nothing of others", () => {
	const { db, commands } = setup();
	commands.prepareInTransaction(db, makeCommand());
	commands.prepareInTransaction(
		db,
		makeCommand({ commandId: "keep", taskId: "task-2" }),
	);
	db.query(
		"INSERT INTO dots_schedules VALUES('s','conn','task-1','cmd-1',9)",
	).run();
	db.query("INSERT INTO dots_reminders VALUES('s','o','r')").run();
	db.query("INSERT INTO dots_deliveries VALUES('d','cmd-1','{}')").run();
	db.query("INSERT INTO dots_sessions VALUES('th','task-1','{}')").run();
	commands.purgeInTransaction(db, "task-1");
	for (const table of [
		"dots_schedules",
		"dots_reminders",
		"dots_deliveries",
		"dots_sessions",
	])
		expect(db.query(`SELECT count(*) n FROM ${table}`).get()).toEqual({ n: 0 });
	expect(db.query("SELECT id FROM dots_commands").all()).toEqual([
		{ id: "keep" },
	]);
});
