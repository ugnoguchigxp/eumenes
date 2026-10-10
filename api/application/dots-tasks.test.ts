import { afterEach, expect, test } from "bun:test";
import { dotsFixture } from "./dots-fixture";
import { createTaskReportDelivery } from "./task-report-delivery";
const clean: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const f of clean.splice(0)) await f();
});
const setup = async () => {
	const f = await dotsFixture();
	clean.push(f.close);
	return f;
};
test("claimed session blocks, answers on the same task and completes only with condition evidence", async () => {
	const f = await setup(),
		r = await f.tasks.create(f.input()),
		c = f.command(r.taskId);
	expect(f.tasks.get(r.taskId).task.state).toBe("queued");
	const lease = crypto.randomUUID();
	await f.dots.claim("dots", { commandId: c.commandId, leaseId: lease });
	await expect(
		f.dots.claim("dots", {
			commandId: c.commandId,
			leaseId: crypto.randomUUID(),
		}),
	).rejects.toThrow("dots_conflict");
	await f.dots.report(
		"dots",
		f.report(c, 1, "session_started", { sessions: [f.session] }),
	);
	const blocked = f.report(c, 2, "blocked", {
		question: {
			questionId: "question",
			prompt: "Choose target",
			answerType: "text",
			choices: [],
		},
	});
	const accepted = await f.dots.report("dots", blocked);
	expect(await f.dots.report("dots", blocked)).toEqual(accepted);
	await expect(
		f.dots.report("dots", { ...blocked, summary: "changed" }),
	).rejects.toThrow("dots_conflict");
	await f.tasks.recover();
	await f.dots.recover();
	expect(f.tasks.get(r.taskId).task.state).toBe("waiting_user");
	const before = f.tasks.get(r.taskId).task;
	await f.tasks.answer(r.taskId, {
		requestId: crypto.randomUUID(),
		expectedRevision: before.revision,
		questionId: "question",
		answer: "Target A",
	});
	await expect(
		f.dots.report("dots", f.report(c, 3, "progress")),
	).rejects.toThrow("dots_stale");
	const a = f.command(r.taskId, "answer");
	expect(a.snapshot.sessions).toEqual([f.session]);
	expect(a.snapshot.answer).toEqual({
		questionId: "question",
		text: "Target A",
	});
	await f.dots.claim("dots", {
		commandId: a.commandId,
		leaseId: crypto.randomUUID(),
	});
	await f.dots.report("dots", f.report(a, 3, "accepted"));
	await expect(
		f.dots.report("dots", f.report(a, 4, "completed")),
	).rejects.toThrow("invalid_dots_completion");
	const complete = f.report(a, 4, "completed", {
		evidenceRefs: ["test-run"],
		completionChecks: [{ status: "satisfied", evidenceRefs: ["test-run"] }],
	});
	await f.dots.report("dots", complete);
	expect(f.tasks.get(r.taskId).task.state).toBe("completed");
	expect(await f.dots.report("dots", complete)).toMatchObject({
		state: "completed",
		verification: "dots_reported",
	});
});
test("owner, project, lease, source sequence and cancellation fences reject unauthorized reports", async () => {
	const f = await setup(),
		r = await f.tasks.create(f.input()),
		c = f.command(r.taskId);
	expect(() => f.dots.getCommand("other", c.commandId)).toThrow(
		"dots_permission_denied",
	);
	await expect(
		f.dots.report("dots", f.report(c, 1, "accepted")),
	).rejects.toThrow("dots_stale");
	await f.dots.claim("dots", {
		commandId: c.commandId,
		leaseId: crypto.randomUUID(),
	});
	await expect(
		f.dots.report("dots", f.report(c, 2, "accepted")),
	).rejects.toThrow("dots_sequence_gap");
	await expect(
		f.dots.report(
			"dots",
			f.report(c, 1, "session_started", {
				sessions: [{ ...f.session, projectId: "unrelated" }],
			}),
		),
	).rejects.toThrow("dots_permission_denied");
	await f.dots.report(
		"dots",
		f.report(c, 1, "session_started", { sessions: [f.session] }),
	);
	const task = f.tasks.get(r.taskId).task;
	await f.tasks.stop(r.taskId, {
		requestId: crypto.randomUUID(),
		expectedRevision: task.revision,
		intent: "cancel",
	});
	await expect(
		f.dots.report(
			"dots",
			f.report(c, 2, "completed", {
				evidenceRefs: ["test"],
				completionChecks: [{ status: "satisfied", evidenceRefs: ["test"] }],
			}),
		),
	).rejects.toThrow("dots_stale");
	const stop = f.command(r.taskId, "stop");
	await f.tasks.maintenance();
	expect(f.command(r.taskId, "stop").commandId).toBe(stop.commandId);
	await f.dots.claim("dots", {
		commandId: stop.commandId,
		leaseId: crypto.randomUUID(),
	});
	await expect(
		f.dots.report(
			"dots",
			f.report(stop, 2, "stopped", { childrenStopped: true }),
		),
	).rejects.toThrow("invalid_dots_stop");
	await f.dots.report(
		"dots",
		f.report(stop, 2, "stopped", {
			childrenStopped: true,
			sessions: [f.session],
		}),
	);
	expect(f.tasks.get(r.taskId).task.state).toBe("cancelled");
});
test("configuration change revokes execution and leaves only a stop command", async () => {
	const f = await setup(),
		r = await f.tasks.create(f.input()),
		c = f.command(r.taskId);
	await f.dots.claim("dots", {
		commandId: c.commandId,
		leaseId: crypto.randomUUID(),
	});
	await f.dots.config.configure({
		id: "dots",
		expectedRevision: 1,
		title: "disabled",
		enabled: false,
		oauth: null,
	});
	expect(() => f.dots.getCommand("dots", c.commandId)).toThrow();
	expect(f.tasks.get(r.taskId).task.state).toBe("stopping");
	const stop = f.command(r.taskId, "stop");
	expect(stop.snapshot.task).toEqual({ id: r.taskId, stopIntent: "pause" });
	await f.dots.claim("dots", {
		commandId: stop.commandId,
		leaseId: crypto.randomUUID(),
	});
	await f.dots.report(
		"dots",
		f.report(stop, 1, "stopped", { childrenStopped: true }),
	);
	expect(f.tasks.get(r.taskId).task.state).toBe("paused");
});
test("forget removes private snapshots and report bodies but retains minimal stop reconciliation", async () => {
	const f = await setup(),
		r = await f.tasks.create(f.input()),
		c = f.command(r.taskId);
	await f.dots.claim("dots", {
		commandId: c.commandId,
		leaseId: crypto.randomUUID(),
	});
	await f.dots.report(
		"dots",
		f.report(c, 1, "session_started", { sessions: [f.session] }),
	);
	await f.tasks.forget(r.taskId, {
		requestId: crypto.randomUUID(),
		expectedRevision: f.tasks.get(r.taskId).task.revision,
	});
	expect(JSON.stringify(f.dots.taskSnapshot("dots", r.taskId))).not.toContain(
		"Implement the requested change",
	);
	const snapshots = f.store.readSnapshot((db) =>
		db
			.query("SELECT data_json FROM dots_commands WHERE task_id=?")
			.all(r.taskId),
	);
	expect(JSON.stringify(snapshots)).not.toContain(
		"Implement the requested change",
	);
	expect(
		f.store.readSnapshot((db) =>
			db.query("SELECT count(*) n FROM dots_reports").get(),
		),
	).toEqual({ n: 0 });
});
test("restart reconciles existing session refs without replaying start; user schedules dedupe occurrences", async () => {
	const f = await setup(),
		r = await f.tasks.create(f.input()),
		c = f.command(r.taskId);
	await f.dots.claim("dots", {
		commandId: c.commandId,
		leaseId: crypto.randomUUID(),
	});
	await f.dots.report(
		"dots",
		f.report(c, 1, "session_started", { sessions: [f.session] }),
	);
	await f.tasks.recover();
	await f.dots.recover();
	const recovery = f.command(r.taskId, "reconcile");
	expect(recovery.snapshot.sessions).toEqual([f.session]);
	await f.dots.claim("dots", {
		commandId: recovery.commandId,
		leaseId: crypto.randomUUID(),
	});
	await f.dots.report("dots", f.report(recovery, 2, "accepted"));
	await expect(
		f.dots.report(
			"dots",
			f.report(recovery, 3, "reminder", {
				reminder: { scheduleRef: "unregistered", occurrenceRef: "1" },
			}),
		),
	).rejects.toThrow("dots_permission_denied");
	const bound = await f.dots.bindSchedule(r.taskId, "schedule");
	const reminder = f.dots.getCommand("dots", bound.commandId);
	await f.dots.claim("dots", {
		commandId: reminder.commandId,
		leaseId: crypto.randomUUID(),
	});
	await f.dots.report(
		"dots",
		f.report(reminder, 3, "reminder", {
			reminder: { scheduleRef: "schedule", occurrenceRef: "1" },
		}),
	);
	await expect(
		f.dots.report(
			"dots",
			f.report(reminder, 4, "reminder", {
				reminder: { scheduleRef: "schedule", occurrenceRef: "1" },
			}),
		),
	).rejects.toThrow("dots_conflict");
});
test("report delivery saves one attributed message to its originating conversation", async () => {
	const f = await setup();
	const r = await f.tasks.create(f.input(), {
			origin: {
				source: "conversation",
				conversationId: "conversation",
				messageId: "message",
				runId: null,
				operationKey: "dots:0",
			},
		}),
		c = f.command(r.taskId);
	await f.dots.claim("dots", {
		commandId: c.commandId,
		leaseId: crypto.randomUUID(),
	});
	await f.dots.report("dots", f.report(c, 1, "accepted"));
	const deliver = createTaskReportDelivery(f.reports, f.tasks, f.conversation);
	await f.store.write(deliver);
	await f.store.write(deliver);
	const messages = f.store.readSnapshot((db) =>
		f.conversation.messagesInTransaction(db, "conversation"),
	);
	expect(messages).toHaveLength(1);
	expect(messages[0]!.text).toContain("fixture report");
});

test("a bound reminder remains usable after completion and grant expiry, but cannot restart work", async () => {
	const f = await setup(),
		input = f.input();
	input.grant.expiresAt = new Date(Date.now() + 1500).toISOString();
	const r = await f.tasks.create(input),
		c = f.command(r.taskId);
	await f.dots.claim("dots", {
		commandId: c.commandId,
		leaseId: crypto.randomUUID(),
	});
	await f.dots.report(
		"dots",
		f.report(c, 1, "session_started", { sessions: [f.session] }),
	);
	const bound = await f.dots.bindSchedule(r.taskId, "completed-schedule");
	await f.dots.report(
		"dots",
		f.report(c, 2, "completed", {
			evidenceRefs: ["check"],
			completionChecks: [{ status: "satisfied", evidenceRefs: ["check"] }],
		}),
	);
	await Bun.sleep(1600);
	const reminder = f.dots.getCommand("dots", bound.commandId);
	await f.dots.claim("dots", {
		commandId: reminder.commandId,
		leaseId: crypto.randomUUID(),
	});
	await expect(
		f.dots.report(
			"dots",
			f.report(reminder, 3, "session_started", { sessions: [f.session] }),
		),
	).rejects.toThrow("invalid_dots_report");
	await f.dots.report(
		"dots",
		f.report(reminder, 3, "reminder", {
			reminder: { scheduleRef: "completed-schedule", occurrenceRef: "1" },
		}),
	);
	expect(f.tasks.get(r.taskId).task.state).toBe("completed");
	await f.tasks.forget(r.taskId, {
		requestId: crypto.randomUUID(),
		expectedRevision: f.tasks.get(r.taskId).task.revision,
	});
	expect(() => f.dots.getCommand("dots", bound.commandId)).toThrow();
});

test("the retained-body limit reserves space for stop commands and stop confirmation", async () => {
	const f = await setup(),
		r = await f.tasks.create(f.input()),
		c = f.command(r.taskId);
	await f.dots.claim("dots", {
		commandId: c.commandId,
		leaseId: crypto.randomUUID(),
	});
	await f.dots.report(
		"dots",
		f.report(c, 1, "session_started", { sessions: [f.session] }),
	);
	await f.store.write((db) => {
		for (let seq = 2; seq <= 1000; seq++) {
			const report = f.report(c, seq, "progress");
			db.query("INSERT INTO dots_reports VALUES(?,?,?,?,?,?)").run(
				report.reportId,
				r.taskId,
				seq,
				"fixture",
				JSON.stringify(report),
				"{}",
			);
		}
		const used = (
			db.query("SELECT bytes FROM dots_storage WHERE id=1").get() as {
				bytes: number;
			}
		).bytes;
		db.query("INSERT INTO dots_dialogue_receipts VALUES(?,?,?,?)").run(
			"capacity-fixture",
			"other",
			"other",
			JSON.stringify("x".repeat(56 * 1024 * 1024 - used - 2)),
		);
	});
	await expect(f.tasks.create(f.input())).rejects.toThrow("dots_capacity");
	await f.tasks.stop(r.taskId, {
		requestId: crypto.randomUUID(),
		expectedRevision: f.tasks.get(r.taskId).task.revision,
		intent: "cancel",
	});
	const stop = f.command(r.taskId, "stop");
	expect(stop.snapshot.capability).toBeNull();
	await f.dots.claim("dots", {
		commandId: stop.commandId,
		leaseId: crypto.randomUUID(),
	});
	await f.dots.report(
		"dots",
		f.report(stop, 1001, "stopped", {
			sessions: [f.session],
			childrenStopped: true,
		}),
	);
	expect(f.tasks.get(r.taskId).task.state).toBe("cancelled");
});

test("a connection cannot transfer its existing task history to a different OAuth principal", async () => {
	const f = await setup();
	const oauth = {
		issuer: "https://issuer.example",
		jwksUrl: "https://issuer.example/keys",
		resource: "https://product.example/mcp/dots/secure",
		subject: "owner",
	};
	await f.dots.config.configure({
		id: "secure",
		title: "secure",
		expectedRevision: 0,
		enabled: true,
		oauth,
	});
	const input = {
		id: "secure",
		title: "secure",
		expectedRevision: 1,
		enabled: true,
		oauth,
	};
	for (const changed of [
		{ ...oauth, subject: "different" },
		{ ...oauth, issuer: "https://other.example" },
		{ ...oauth, resource: "https://other.example/mcp/dots/secure" },
		null,
	])
		await expect(
			f.dots.config.configure({ ...input, oauth: changed }),
		).rejects.toThrow("dots_owner_immutable");
	await f.tasks.create(f.input());
	await expect(
		f.dots.config.configure({
			id: "dots",
			title: "dots",
			expectedRevision: 1,
			enabled: true,
			oauth: { ...oauth, resource: "https://product.example/mcp/dots/dots" },
		}),
	).rejects.toThrow("dots_owner_immutable");
	expect(
		f.dots.config.list().connections.find((c) => c.id === "secure")?.revision,
	).toBe(1);
});
