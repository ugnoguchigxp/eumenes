import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { harness } from "./toolchain.fixture";

async function manualActionRoot(
	h: Awaited<ReturnType<typeof harness>>,
	runId: string,
) {
	for (let i = 0; i < 100 && h.routeContexts.length === 0; i++)
		await Bun.sleep(5);
	const id = crypto.randomUUID();
	await h.store.write((db) => {
		db.query(
			"INSERT INTO agent_tasks(id,kind,root_run_id,state,phase,deadline,created_at,updated_at) VALUES(?,'coordinator',?,'queued','route',?,0,0)",
		).run(id, runId, Date.now() + 60000);
		db.query("UPDATE dialogue_runs SET agent_task_id=? WHERE id=?").run(
			id,
			runId,
		);
	});
	return id;
}
test("C01-C03: a relative timer request is saved through the toolchain", async () => {
	const h = await harness({ timers: true });
	try {
		const run = await h.dialogue.submit({
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: "3分タイマー測って",
		});
		const done = await h.dialogue.waitForTerminal(run.id, { timeoutMs: 8000 });
		expect(done?.status).toBe("completed");
		expect(h.dialogue.answerText(run.id)).toContain("3分");
		const saved = h.store.read((db) => ({
			timers: db
				.query("SELECT duration_seconds, state FROM timers")
				.all() as Array<{
				duration_seconds: number;
				state: string;
			}>,
			schedules: (
				db.query("SELECT COUNT(*) AS n FROM scheduler_schedules").get() as {
					n: number;
				}
			).n,
			operations: db
				.query("SELECT operation, receipt_digest FROM timer_operations")
				.all() as Array<{ operation: string; receipt_digest: string }>,
			actions: db
				.query(
					"SELECT tool_revision_id, receipt_digest, operation_id, root_run_id, owner_task_id, step_id FROM tool_action_invocations",
				)
				.all() as Array<{
				tool_revision_id: string;
				receipt_digest: string;
				operation_id: string;
				root_run_id: string;
				owner_task_id: string;
				step_id: string;
			}>,
			results: db
				.query(
					"SELECT invocation_id, operation_id, receipt_digest FROM agent_action_results",
				)
				.all() as Array<{
				invocation_id: string;
				operation_id: string;
				receipt_digest: string;
			}>,
		}));
		expect(saved.timers).toEqual([{ duration_seconds: 180, state: "active" }]);
		expect(saved.schedules).toBe(1);
		expect(saved.operations.map((row) => row.operation)).toEqual(["start"]);
		expect(saved.actions).toHaveLength(1);
		expect(saved.actions[0]?.tool_revision_id).toBe("tool:timer.start@1");
		expect(saved.actions[0]?.root_run_id).toBe(run.id);
		expect(saved.actions[0]?.receipt_digest).toBe(
			saved.operations[0]?.receipt_digest,
		);
		expect(saved.results).toHaveLength(1);
		expect(saved.results[0]?.operation_id).toBe(saved.actions[0]?.operation_id);
		expect(saved.results[0]?.receipt_digest).toBe(
			saved.actions[0]?.receipt_digest,
		);
		expect(h.workerContexts).toHaveLength(0);
		expect(h.routeContexts[0]).toContain("現在のタイマーのsnapshot");
		expect(h.routeContexts[0]).toContain("3分タイマー測って");
		const origin = h.store.read((db) =>
			db.query("SELECT conversation_id, origin_message_id FROM timers").get(),
		);
		expect(origin).toEqual({
			conversation_id: "main",
			origin_message_id: run.inputMessageId,
		});
		expect(h.acquisitions).toBe(0);
		expect(h.calls).toBe(2);
	} finally {
		await h.close();
	}
});

for (const [text, seconds] of [
	["90秒タイマー", 90],
	["1時間のタイマー", 3600],
	["3分30秒のタイマー", 210],
] as const)
	test(`relative duration ${text} is stored as ${seconds} seconds`, async () => {
		const h = await harness({ timers: true });
		try {
			const run = await h.dialogue.submit({
				requestId: crypto.randomUUID(),
				conversationId: "main",
				text,
			});
			expect(
				(await h.dialogue.waitForTerminal(run.id, { timeoutMs: 8000 }))?.status,
			).toBe("completed");
			const row = h.store.read(
				(db) =>
					db.query("SELECT duration_seconds FROM timers").get() as {
						duration_seconds: number;
					},
			);
			expect(row.duration_seconds).toBe(seconds);
			expect(h.dialogue.answerText(run.id)).toContain(
				seconds === 90 ? "1分30秒" : seconds === 3600 ? "1時間" : "3分30秒",
			);
		} finally {
			await h.close();
		}
	});

test("C06: cancelling the dialogue run leaves the committed timer active", async () => {
	const h = await harness({ timers: true });
	try {
		const run = await h.dialogue.submit({
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: "3分タイマー測って",
		});
		expect(
			(await h.dialogue.waitForTerminal(run.id, { timeoutMs: 8000 }))?.status,
		).toBe("completed");
		await h.dialogue.cancel(run.id);
		const row = h.store.read(
			(db) => db.query("SELECT state FROM timers").get() as { state: string },
		);
		expect(row.state).toBe("active");
	} finally {
		await h.close();
	}
});

function counts(store: {
	read: <T>(fn: (db: import("bun:sqlite").Database) => T) => T;
}) {
	return store.read((db) => ({
		timers: (
			db.query("SELECT COUNT(*) AS n FROM timers").get() as { n: number }
		).n,
		schedules: (
			db.query("SELECT COUNT(*) AS n FROM scheduler_schedules").get() as {
				n: number;
			}
		).n,
		operations: (
			db.query("SELECT COUNT(*) AS n FROM timer_operations").get() as {
				n: number;
			}
		).n,
		actions: (
			db.query("SELECT COUNT(*) AS n FROM tool_action_invocations").get() as {
				n: number;
			}
		).n,
	}));
}

test("C04: a revoked skill or a strict-invalid command does not start a timer", async () => {
	const revoked = await harness({ timers: true });
	try {
		await revoked.store.write((db) => {
			revoked.toolchain.capabilities.setEnabledInTransaction(
				db,
				"skill",
				"timers.manage",
				false,
			);
		});
		const run = await revoked.dialogue.submit({
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: "90秒タイマー測って",
		});
		await revoked.dialogue.waitForTerminal(run.id, { timeoutMs: 8000 });
		expect(counts(revoked.store).timers).toBe(0);
		expect(revoked.dialogue.answerText(run.id) ?? "").not.toContain("開始");
	} finally {
		await revoked.close();
	}
	const extra = await harness({ timers: true, timerExtra: true });
	try {
		const run = await extra.dialogue.submit({
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: "90秒タイマー測って",
		});
		await extra.dialogue.waitForTerminal(run.id, { timeoutMs: 8000 });
		expect(counts(extra.store).timers).toBe(0);
		expect(extra.dialogue.answerText(run.id) ?? "").not.toContain("開始");
	} finally {
		await extra.close();
	}
});

test("C04: another owner or extra arguments are refused before a timer is saved", async () => {
	const h = await harness({ timers: true });
	try {
		const owner = {
			rootRunId: crypto.randomUUID(),
			taskId: crypto.randomUUID(),
			cancelEpoch: 0,
		};
		const deadline = Date.now() + 60_000;
		await expect(
			h.store.write((db) => {
				const prepared =
					h.toolchain.capabilities.prepareActiveByIdInTransaction(
						db,
						owner,
						"package:timers.manage@1",
						{ operation: "start", durationSeconds: 90 },
					);
				const bound = h.toolchain.tools.bind(owner, prepared, deadline);
				const start = bound.find((item) => item.tool.id === "timer.start");
				if (!start) throw new Error("missing_timer_start");
				h.toolchain.tools.invokeActionInTransaction(
					db,
					{ ...owner, taskId: crypto.randomUUID() },
					start.executionRef,
					{ durationSeconds: 90 },
					crypto.randomUUID(),
					deadline,
					`${owner.rootRunId}:0`,
				);
			}),
		).rejects.toThrow("tool_ref_invalid");
		await expect(
			h.store.write((db) => {
				const prepared =
					h.toolchain.capabilities.prepareActiveByIdInTransaction(
						db,
						owner,
						"package:timers.manage@1",
						{ operation: "start", durationSeconds: 90 },
					);
				const bound = h.toolchain.tools.bind(owner, prepared, deadline);
				const start = bound.find((item) => item.tool.id === "timer.start");
				if (!start) throw new Error("missing_timer_start");
				h.toolchain.tools.invokeActionInTransaction(
					db,
					owner,
					start.executionRef,
					{ durationSeconds: 90, scope: "other" },
					crypto.randomUUID(),
					deadline,
					`${owner.rootRunId}:0`,
				);
			}),
		).rejects.toThrow("invalid_tool_input");
		expect(counts(h.store)).toEqual({
			timers: 0,
			schedules: 0,
			operations: 0,
			actions: 0,
		});
	} finally {
		await h.close();
	}
});

test("C05: a failure before the action result rolls the timer back, and the same step then saves one", async () => {
	let release!: () => void;
	const routeGate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const h = await harness({ timers: true, routeGate });
	let runId: string | undefined;
	try {
		const run = await h.dialogue.submit({
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: "90秒タイマー",
		});
		runId = run.id;
		const owner = {
			rootRunId: run.id,
			taskId: await manualActionRoot(h, run.id),
			cancelEpoch: 0,
		};
		const stepId = crypto.randomUUID();
		const deadline = Date.now() + 60_000;
		const startOf = (db: Database) => {
			const prepared = h.toolchain.capabilities.prepareActiveByIdInTransaction(
				db,
				owner,
				"package:timers.manage@1",
				{ operation: "start", durationSeconds: 90 },
			);
			const bound = h.toolchain.tools.bind(owner, prepared, deadline);
			const start = bound.find((item) => item.tool.id === "timer.start");
			if (!start) throw new Error("missing_timer_start");
			return start;
		};
		await expect(
			h.store.write((db) => {
				const start = startOf(db);
				h.toolchain.tools.invokeActionInTransaction(
					db,
					owner,
					start.executionRef,
					{ durationSeconds: 90 },
					stepId,
					deadline,
					`${owner.rootRunId}:0`,
				);
				throw new Error("injected_before_action_result");
			}),
		).rejects.toThrow("injected_before_action_result");
		expect(counts(h.store)).toEqual({
			timers: 0,
			schedules: 0,
			operations: 0,
			actions: 0,
		});
		await h.store.write((db) => {
			const start = startOf(db);
			const saved = h.toolchain.tools.invokeActionInTransaction(
				db,
				owner,
				start.executionRef,
				{ durationSeconds: 90 },
				stepId,
				deadline,
				`${owner.rootRunId}:0`,
			);
			db.query(
				`INSERT INTO agent_action_results(task_id,invocation_id,operation_id,receipt_digest,payload_json,created_at)
         VALUES(?,?,?,?,?,?)`,
			).run(
				owner.taskId,
				saved.invocationId,
				saved.operationId,
				saved.receiptDigest,
				JSON.stringify(saved.payload),
				Date.now(),
			);
		});
		expect(counts(h.store)).toEqual({
			timers: 1,
			schedules: 1,
			operations: 1,
			actions: 1,
		});
		const duration = h.store.read(
			(db) =>
				(
					db.query("SELECT duration_seconds FROM timers").get() as {
						duration_seconds: number;
					}
				).duration_seconds,
		);
		expect(duration).toBe(90);
	} finally {
		if (runId) await h.dialogue.cancel(runId);
		release();
		await h.close();
	}
});

test("C07: list and cancel stay on one operation when the same step runs again", async () => {
	let release!: () => void;
	const routeGate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const h = await harness({
		timers: true,
		routeGate,
		routeGateQuestion: "確認",
	});
	let actionRunId: string | undefined;
	try {
		const run = await h.dialogue.submit({
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: "90秒タイマー測って",
		});
		expect(
			(await h.dialogue.waitForTerminal(run.id, { timeoutMs: 8000 }))?.status,
		).toBe("completed");
		const actionRun = await h.dialogue.submit({
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: "タイマーを確認して取り消して",
		});
		actionRunId = actionRun.id;
		await manualActionRoot(h, actionRun.id);
		const root = h.store.read(
			(db) =>
				db
					.query(
						"SELECT id, cancel_epoch FROM agent_tasks WHERE root_run_id=? AND kind='coordinator'",
					)
					.get(actionRun.id) as { id: string; cancel_epoch: number },
		);
		const timer = h.store.read(
			(db) =>
				db.query("SELECT id, revision FROM timers").get() as {
					id: string;
					revision: number;
				},
		);
		const owner = {
			rootRunId: actionRun.id,
			taskId: root.id,
			cancelEpoch: root.cancel_epoch,
		};
		const deadline = Date.now() + 60_000;
		const repeat = (
			operation: "list" | "cancel",
			args: Record<string, unknown>,
		) => {
			const stepId = crypto.randomUUID();
			return h.store.write((db) => {
				const prepared =
					h.toolchain.capabilities.prepareActiveByIdInTransaction(
						db,
						owner,
						"package:timers.manage@1",
						operation === "list"
							? { operation: "list" }
							: {
									operation: "cancel",
									timerId: timer.id,
									expectedRevision: timer.revision,
								},
					);
				const bound = h.toolchain.tools.bind(owner, prepared, deadline);
				const tool = bound.find(
					(item) => item.tool.id === `timer.${operation}`,
				);
				if (!tool) throw new Error(`missing_timer_${operation}`);
				h.toolchain.tools.invokeActionInTransaction(
					db,
					owner,
					tool.executionRef,
					args,
					stepId,
					deadline,
					`${actionRun.id}:${root.cancel_epoch}`,
				);
				h.toolchain.tools.invokeActionInTransaction(
					db,
					owner,
					tool.executionRef,
					args,
					stepId,
					deadline,
					`${actionRun.id}:${root.cancel_epoch}`,
				);
			});
		};
		await repeat("list", {});
		await repeat("cancel", {
			timerId: timer.id,
			expectedRevision: timer.revision,
		});
		const operations = h.store.read(
			(db) =>
				db
					.query(
						"SELECT operation FROM timer_operations ORDER BY created_at_ms",
					)
					.all() as Array<{
					operation: string;
				}>,
		);
		expect(operations.map((row) => row.operation)).toEqual([
			"start",
			"list",
			"cancel",
		]);
		expect(
			h.store.read((db) => db.query("SELECT state FROM timers").get()),
		).toEqual({
			state: "cancelled",
		});
	} finally {
		if (actionRunId) await h.dialogue.cancel(actionRunId);
		release();
		await h.close();
	}
});

test("C08: without timer ports a timer request does not invent a start", async () => {
	const h = await harness();
	try {
		const run = await h.dialogue.submit({
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: "3分タイマー測って",
		});
		const done = await h.dialogue.waitForTerminal(run.id, { timeoutMs: 8000 });
		expect(done?.status).toBe("completed");
		const text = h.dialogue.answerText(run.id) ?? "";
		expect(text).not.toContain("開始");
		const count = h.store.read(
			(db) =>
				(db.query("SELECT COUNT(*) AS n FROM timers").get() as { n: number }).n,
		);
		expect(count).toBe(0);
	} finally {
		await h.close();
	}
});

test("real dialogue list and cancel select an authoritative timer snapshot", async () => {
	const h = await harness({ timers: true });
	try {
		const ask = async (text: string) => {
			const run = await h.dialogue.submit({
				requestId: crypto.randomUUID(),
				conversationId: "main",
				text,
			});
			expect(
				(await h.dialogue.waitForTerminal(run.id, { timeoutMs: 8000 }))?.status,
			).toBe("completed");
			return h.dialogue.answerText(run.id);
		};
		await ask("90秒タイマー");
		expect(await ask("タイマーの残りを確認して")).toContain("残り");
		const timer = h.timers!.list().items[0]!;
		expect(h.routeContexts[1]).toContain(timer.id);
		expect(h.routeContexts[1]).toContain("revision");
		expect(await ask("タイマーを止めて")).toContain("取り消");
		expect(h.timers!.get(timer.id)?.timer.state).toBe("cancelled");
		expect(h.calls).toBe(6);
	} finally {
		await h.close();
	}
});

test("a made-up origin cannot authorize a timer through a valid capability reference", async () => {
	const h = await harness({ timers: true });
	try {
		const owner = {
			rootRunId: crypto.randomUUID(),
			taskId: crypto.randomUUID(),
			cancelEpoch: 0,
		};
		await expect(
			h.store.write((db) => {
				const p = h.toolchain.capabilities.prepareActiveByIdInTransaction(
					db,
					owner,
					"package:timers.manage@1",
					{ operation: "start", durationSeconds: 90 },
				);
				const tool = h.toolchain.tools
					.bind(owner, p, Date.now() + 60000)
					.find((t) => t.tool.id === "timer.start")!;
				h.toolchain.tools.invokeActionInTransaction(
					db,
					owner,
					tool.executionRef,
					{ durationSeconds: 90 },
					crypto.randomUUID(),
					Date.now() + 60000,
					`${owner.rootRunId}:0`,
				);
			}),
		).rejects.toThrow("origin_invalid");
		expect(counts(h.store).timers).toBe(0);
	} finally {
		await h.close();
	}
});

test("cancellation after preparation refreshes the result before the agent phrases it", async () => {
	const h = await harness({ timers: true });
	let changed = false;
	let cancellation: Promise<unknown> | undefined;
	const unsubscribe = h.store.onCommit(() => {
		if (changed) return;
		const run = h.store.read((db) =>
			db.query("SELECT id FROM dialogue_runs WHERE status='running'").get(),
		);
		const timer = h.timers!.list().items[0];
		if (!run || !timer) return;
		changed = true;
		cancellation = h.timers!.cancel(timer.id, {
			requestId: crypto.randomUUID(),
			issuedAt: new Date().toISOString(),
			expectedRevision: timer.revision,
		});
	});
	try {
		const run = await h.dialogue.submit({
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: "90秒タイマー",
		});
		expect(
			(await h.dialogue.waitForTerminal(run.id, { timeoutMs: 8000 }))?.status,
		).toBe("completed");
		await cancellation;
		expect(changed).toBe(true);
		expect(h.dialogue.answerText(run.id)).toContain("取り消");
		expect(h.dialogue.answerText(run.id)).not.toContain("開始");
		expect(h.calls).toBe(2);
	} finally {
		unsubscribe();
		await h.close();
	}
});

test("a corrupted receipt after preparation cannot be adopted or streamed", async () => {
	const h = await harness({ timers: true });
	let corrupted = false;
	const unsubscribe = h.store.onCommit(() => {
		if (corrupted) return;
		if (
			!h.store.read((db) =>
				db
					.query(
						"SELECT d.id FROM dialogue_runs d WHERE d.status='running' AND EXISTS(SELECT 1 FROM agent_action_results a JOIN agent_tasks t ON t.id=a.task_id WHERE t.root_run_id=d.id)",
					)
					.get(),
			)
		)
			return;
		corrupted = true;
		void h.store.write((db) =>
			db.query("UPDATE timer_operations SET receipt_digest='corrupt'").run(),
		);
	});
	try {
		const run = await h.dialogue.submit({
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: "90秒タイマー",
		});
		const progress: string[] = [];
		const stop = h.dialogue.subscribeProgress(run.id, (value) => {
			progress.push(value.text);
		});
		expect(
			(await h.dialogue.waitForTerminal(run.id, { timeoutMs: 8000 }))?.status,
		).toBe("failed");
		stop();
		expect(h.dialogue.answerText(run.id)).toBeNull();
		expect(progress.every((text) => !text.includes("開始"))).toBe(true);
	} finally {
		unsubscribe();
		await h.close();
	}
});
