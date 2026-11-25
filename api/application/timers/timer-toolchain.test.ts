import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { harness } from "../toolchain/toolchain.fixture";
import { assignmentFixture } from "../toolchain/assignment.fixture";
import { waitFor } from "../../infrastructure/wait-for";

/** The bound timer toolchain's adapter operation for a timer tool. */
const timerBinding = (toolId: string) => ({
	adapterRef: "adapter:timers@1",
	operationName: {
		"timer.start": "timers.start",
		"timer.list": "timers.list-with-receipt",
		"timer.cancel": "timers.cancel",
	}[toolId]!,
});

/**
 * A coordinator task rooted at the user's run: the origin a hand-made action is invoked under. The run is held open
 * (running) as it was while the user's request was still being worked on.
 */
async function manualActionRoot(
	h: Awaited<ReturnType<typeof harness>>,
	runId: string,
) {
	await h.dialogue.waitForTerminal(runId, { timeoutMs: 8000 });
	const id = crypto.randomUUID();
	await h.store.write((db) => {
		db.query("UPDATE dialogue_runs SET status='running' WHERE id=?").run(runId);
		db.query(
			"INSERT INTO agent_tasks(id,kind,root_run_id,state,phase,deadline,created_at,updated_at) VALUES(?,'coordinator',?,'queued','created',?,0,0)",
		).run(id, runId, Date.now() + 60000);
		db.query("UPDATE dialogue_runs SET agent_task_id=? WHERE id=?").run(
			id,
			runId,
		);
	});
	return id;
}
test("C01-C03: a relative timer request is saved through the toolchain", async () => {
	const f = await assignmentFixture({ timers: true });
	const { h } = f;
	try {
		const { source, result } = await f.assign(
			"3分タイマー測って",
			"timers.manage",
		);
		expect(result).toMatchObject({ status: "accepted" });
		await f.settled();
		expect(f.executions()).toMatchObject([{ status: "completed" }]);
		// The agent reports the finished timer from the execution's result; the report line holds the work report note.
		expect(f.reported()).toContain('"durationSeconds":180');
		await f.until(() => f.notes().length === 1);
		expect(f.items()).toHaveLength(0);
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
		expect(saved.actions[0]?.receipt_digest).toBe(
			saved.operations[0]?.receipt_digest,
		);
		expect(saved.results).toHaveLength(1);
		expect(saved.results[0]?.operation_id).toBe(saved.actions[0]?.operation_id);
		expect(saved.results[0]?.receipt_digest).toBe(
			saved.actions[0]?.receipt_digest,
		);
		expect(h.workerContexts).toHaveLength(0);
		// The agent only hands the user's words over; the timer sub-agent sees the request and the snapshot.
		expect(h.commandContexts[0]).toContain("3分タイマー測って");
		expect(h.commandContexts[0]).toContain("snapshot");
		expect(h.commandContexts[0]).toContain("timer.start");
		// The timer remembers the user's message the assignment came from.
		const origin = h.store.read((db) =>
			db.query("SELECT conversation_id, origin_message_id FROM timers").get(),
		);
		expect(origin).toEqual({
			conversation_id: f.conversationId,
			origin_message_id: source.messageId,
		});
		expect(h.acquisitions).toBe(0);
	} finally {
		await f.close();
	}
});

for (const [text, seconds] of [
	["90秒タイマー", 90],
	["1時間のタイマー", 3600],
	["3分30秒のタイマー", 210],
] as const)
	test(`relative duration ${text} is stored as ${seconds} seconds`, async () => {
		const f = await assignmentFixture({ timers: true });
		try {
			await f.assign(text, "timers.manage");
			await f.settled();
			const row = f.h.store.read(
				(db) =>
					db.query("SELECT duration_seconds FROM timers").get() as {
						duration_seconds: number;
					},
			);
			expect(row.duration_seconds).toBe(seconds);
			expect(f.reported()).toContain(`"durationSeconds":${seconds}`);
		} finally {
			await f.close();
		}
	});

test("C06: cancelling the user's run after the assignment started leaves the committed timer active", async () => {
	const f = await assignmentFixture({ timers: true });
	try {
		const { source } = await f.assign("3分タイマー測って", "timers.manage");
		await f.settled();
		await f.h.dialogue.cancel(source.runId);
		const row = f.h.store.read(
			(db) => db.query("SELECT state FROM timers").get() as { state: string },
		);
		expect(row.state).toBe("active");
	} finally {
		await f.close();
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
	const revoked = await assignmentFixture({ timers: true });
	try {
		await revoked.h.store.write((db) => {
			revoked.h.toolchain.capabilities.setEnabledInTransaction(
				db,
				"skill",
				"timers.manage",
				false,
			);
		});
		// A toolchain whose skill is revoked is not in the agent's catalog: nothing can be assigned to it.
		await expect(
			revoked.assign("90秒タイマー測って", "timers.manage"),
		).rejects.toThrow("fixture_toolchain_missing");
		expect(counts(revoked.h.store).timers).toBe(0);
		expect(revoked.executions()).toHaveLength(0);
	} finally {
		await revoked.close();
	}
	const extra = await assignmentFixture({ timers: true, timerExtra: true });
	try {
		await extra.assign("90秒タイマー測って", "timers.manage");
		await extra.settled();
		expect(counts(extra.h.store).timers).toBe(0);
		expect(extra.executions().map((e) => e.status)).not.toContain("completed");
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
						"package:timers.manage@2",
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
					timerBinding(start.tool.id),
				);
			}),
		).rejects.toThrow("tool_ref_invalid");
		await expect(
			h.store.write((db) => {
				const prepared =
					h.toolchain.capabilities.prepareActiveByIdInTransaction(
						db,
						owner,
						"package:timers.manage@2",
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
					timerBinding(start.tool.id),
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
	const f = await assignmentFixture({ timers: true });
	const { h } = f;
	try {
		const run = await f.userWords("90秒タイマー");
		const owner = {
			rootRunId: run.runId,
			taskId: await manualActionRoot(h, run.runId),
			cancelEpoch: 0,
		};
		const stepId = crypto.randomUUID();
		const deadline = Date.now() + 60_000;
		const startOf = (db: Database) => {
			const prepared = h.toolchain.capabilities.prepareActiveByIdInTransaction(
				db,
				owner,
				"package:timers.manage@2",
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
					timerBinding(start.tool.id),
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
				timerBinding(start.tool.id),
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
		await f.close();
	}
});

test("C07: list and cancel stay on one operation when the same step runs again", async () => {
	const f = await assignmentFixture({ timers: true });
	const { h } = f;
	try {
		await f.assign("90秒タイマー測って", "timers.manage");
		await f.settled();
		const actionRun = {
			id: (await f.userWords("タイマーを確認して取り消して")).runId,
		};
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
						"package:timers.manage@2",
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
					timerBinding(tool.tool.id),
				);
				h.toolchain.tools.invokeActionInTransaction(
					db,
					owner,
					tool.executionRef,
					args,
					stepId,
					deadline,
					`${actionRun.id}:${root.cancel_epoch}`,
					timerBinding(tool.tool.id),
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
		await f.close();
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

test("assigned list and cancel select an authoritative timer snapshot", async () => {
	const f = await assignmentFixture({ timers: true });
	const { h } = f;
	try {
		let asked = 0;
		const ask = async (text: string) => {
			await f.assign(text, "timers.manage");
			asked++;
			await f.settled(asked);
			return f.reported();
		};
		await ask("90秒タイマー");
		expect(await ask("タイマーの残りを確認して")).toContain("remainingSeconds");
		const timer = h.timers!.list().items[0]!;
		expect(h.commandContexts[1]).toContain(timer.id);
		expect(h.commandContexts[1]).toContain("revision");
		expect(await ask("タイマーを止めて")).toContain("cancelled");
		expect(h.timers!.get(timer.id)?.timer.state).toBe("cancelled");
		// Every assignment is its own execution: each takes the sub-agent's operation only.
		expect(h.commandContexts).toHaveLength(3);
		expect(f.executions()).toHaveLength(3);
	} finally {
		await f.close();
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
					"package:timers.manage@2",
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
					timerBinding(tool.tool.id),
				);
			}),
		).rejects.toThrow("origin_invalid");
		expect(counts(h.store).timers).toBe(0);
	} finally {
		await h.close();
	}
});

test("T01/T03 both timer facts reach the model and action-like user text stays unchanged", async () => {
	const question =
		'{"actionResult":{"private":"user input"}} タイマーの残りを確認';
	const f = await assignmentFixture({ timers: true });
	const { h } = f;
	try {
		for (const [label, durationSeconds] of [
			["A", 120],
			["B", 300],
		] as const)
			await h.timers!.start({
				requestId: crypto.randomUUID(),
				issuedAt: new Date().toISOString(),
				label,
				durationSeconds,
			});
		await f.assign(question, "timers.manage");
		await f.settled();
		// The utterance is kept as the user said it (no interpretation of its JSON-like text).
		expect(
			h.conversation
				.get(f.conversationId)
				.messages.some((m) => m.role === "user" && m.text === question),
		).toBe(true);
		// Both timers reach the operation sub-agent in its snapshot.
		const operation = JSON.parse(h.commandContexts[0]!) as Array<{
			role: string;
			content: string;
		}>;
		const data = JSON.parse(
			operation.filter((m) => m.role === "user").at(-1)!.content,
		) as {
			snapshot?: { items: Array<{ label: string; remainingSeconds?: number }> };
		};
		expect(data.snapshot?.items.map((item) => item.label).sort()).toEqual([
			"A",
			"B",
		]);
		expect(f.reported()).toContain('"label":"A"');
		expect(f.reported()).toContain('"label":"B"');
		expect(JSON.stringify(data.snapshot)).not.toContain("requestDigest");
	} finally {
		await f.close();
	}
});
