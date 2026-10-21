import { expect, test } from "bun:test";
import { waitFor } from "../../../infrastructure/wait-for";
import { acceptExecutionPlan } from "../service/execution-plan";
import type { ToolchainCard } from "../../capabilities";
import { createExecutionStore } from "../service/execution-store";
import { executionRow, executionState } from "../repository/executions";
import {
	executionTools,
	parseExecutionDecision,
} from "../service/execution-tools";
import {
	card,
	done,
	finish,
	invoke,
	plan,
	setup,
} from "./task-execution-harness";

test("native reference fields enumerate only issued refs and offer no reader without refs", async () => {
	const h = await setup([], done(), true);
	const started = await h.start();
	const state = h.store.read((db) =>
		executionState(executionRow(db, started.id)!),
	);
	const native = () =>
		executionTools(state, [
			card("lookup"),
			{
				...card("instant"),
				instant: {
					parameters: { type: "object", properties: {} },
					parse: (value: unknown) => ({ ok: true as const, value }),
				},
			} as ToolchainCard,
		]);
	const fields = (tools: ReturnType<typeof native>, name: string) =>
		tools.find((t) => t.function.name === name)!.function.parameters
			.properties as Record<string, any>;
	expect(native().map((tool) => tool.function.name)).toEqual([
		"set_plan",
		"report_partial",
	]);
	acceptExecutionPlan(state, 0, plan("lookup").arguments);
	let tools = native();
	expect(tools.some((t) => t.function.name === "read_reference")).toBe(false);
	for (const name of ["lookup", "instant"])
		expect(fields(tools, name).contextRefs.maxItems).toBe(0);
	expect(fields(tools, "report_partial").refs.maxItems).toBe(0);
	expect(fields(tools, "complete_task").missing.maxItems).toBe(0);
	expect(fields(tools, "report_partial").missing.maxItems).toBe(12);
	state.refs = [
		{
			ref: "issued-ref",
			owner: "memory",
			id: "item",
			revision: "1",
			digest: "digest",
			label: "item",
			kind: "memory",
			preview: "background",
		},
	];
	tools = native();
	for (const name of ["lookup", "instant"])
		expect(fields(tools, name).contextRefs.items.enum).toEqual(["issued-ref"]);
	for (const name of ["complete_task", "report_partial"])
		expect(fields(tools, name).refs.items.enum).toEqual(["issued-ref"]);
	expect(fields(tools, "read_reference").ref.enum).toEqual(["issued-ref"]);
	expect(() =>
		parseExecutionDecision(
			[
				{
					id: "call",
					name: "lookup",
					arguments: JSON.stringify({
						stepRef: state.plan!.items[0]!.stepRef,
						contextRefs: ["https://example.org"],
					}),
				},
			],
			tools,
			[card("lookup")],
			["issued-ref"],
		),
	).toThrow("execution_reference_not_offered");
	state.children = state.limits.childCalls;
	const exhausted = native().map((tool) => tool.function.name);
	expect(exhausted).not.toContain("find_toolchain");
	expect(exhausted).not.toContain("lookup");
	expect(exhausted).toContain("read_reference");
});
test("search → child result → different search → child → completion uses fresh functions and real source IDs", async () => {
	const h = await setup([
		plan("get candidates", "use the confirmed item"),
		{ name: "find_toolchain", arguments: { query: "lookup" } },
		invoke("lookup"),
		{ name: "find_toolchain", arguments: { query: "use candidate" } },
		invoke("operate", 1),
		finish,
	]);
	const started = await h.start();
	await waitFor(() => h.get(started.id).status === "completed", {
		timeout: 3000,
	});
	expect(h.stats()).toMatchObject({ count: 6, searches: 2, dispatches: 2 });
	expect(h.observed[2]!.tools).not.toContain("find_toolchain");
	expect(h.observed[3]!.tools).toContain("find_toolchain");
	expect(h.observed[3]!.context).toContain("confirmed");
	expect(JSON.parse(h.observed[3]!.context).results[0]).toMatchObject({
		toolchainRevisionId: "toolchain:lookup@1",
		stepRequest: "get candidates",
		requestTruncated: false,
		state: "completed",
	});
	const ref = JSON.parse(h.observed[3]!.context).references[0];
	expect(ref).not.toHaveProperty("digest");
	expect(ref).not.toHaveProperty("preview");
	expect(h.observed[5]!.tools).toEqual(["complete_task", "report_partial"]);
	const sources = h.store.read((db) =>
		db.query("SELECT input_json FROM agent_execution_steps").all(),
	) as { input_json: string }[];
	expect(sources.map((r) => JSON.parse(r.input_json).source.runId)).toEqual([
		"real-source-run",
		"real-source-run",
	]);
	expect(new Set(sources.map((r) => JSON.parse(r.input_json).id)).size).toBe(2);
});
test("after an operation, completion must cite its issued result rather than omit evidence; the existing repair can correct it without another operation", async () => {
	const h = await setup([
		plan("lookup"),
		{ name: "find_toolchain", arguments: { query: "lookup" } },
		invoke("lookup"),
		{
			name: "complete_task",
			arguments: {
				summary: "done",
				fulfilled: ["done"],
				missing: [],
				refs: [],
			},
		},
		finish,
	]);
	const started = await h.start();
	await waitFor(() => h.get(started.id).status === "completed", {
		timeout: 3000,
	});
	expect(h.stats()).toMatchObject({ count: 5, dispatches: 1, searches: 1 });
	expect(JSON.parse(h.observed[4]!.context).contractError).toContain(
		"execution_completion_unreferenced",
	);
	expect(h.get(started.id).result!.refs).toHaveLength(1);
	const state = h.store.read((db) =>
		executionState(executionRow(db, started.id)!),
	);
	const native = executionTools(state, []).find(
		(t) => t.function.name === "complete_task",
	)!.function.parameters.properties as Record<string, any>;
	expect(native.refs.contains.enum).toEqual(h.get(started.id).result!.refs);
	expect(native.refs.minItems).toBe(1);
});
test("a start replay is idempotent and cancel during a child prevents subsequent discovery or dispatch", async () => {
	const h = await setup(
		[
			plan("lookup"),
			{ name: "find_toolchain", arguments: { query: "lookup" } },
			invoke("lookup"),
		],
		{ ...done(), state: "running" },
	);
	const started = await h.start();
	expect((await h.start()).id).toBe(started.id);
	await waitFor(
		() =>
			h.get(started.id).status === "waiting_child" &&
			h.stats().dispatches === 1,
		{ timeout: 3000 },
	);
	await h.control(started.id, "cancel");
	h.setResult(done("late result"));
	await h.runtime.reconcile();
	expect(h.get(started.id).status).toBe("cancelled");
	expect(h.stats()).toMatchObject({ dispatches: 1, searches: 1 });
	expect(h.stats().cancels).toBeGreaterThan(0);
});
test("a disabled parent binding rejects a queued decision and an existing child's authority immediately, before background reconciliation", async () => {
	const h = await setup(
		[
			plan("lookup"),
			{ name: "find_toolchain", arguments: { query: "lookup" } },
			invoke("lookup"),
		],
		{ ...done(), state: "running" },
	);
	const started = await h.start();
	await waitFor(
		() =>
			h.get(started.id).status === "waiting_child" && h.children.length === 1,
		{ timeout: 3000 },
	);
	await h.runtime.reconcile();
	h.port.controlInTransaction = () => null;
	expect(
		h.store.read((db) =>
			h.runtime.authorizeChildInTransaction(db, h.children[0]!),
		),
	).toBe(false);
	const ops = createExecutionStore({
		store: h.store,
		queue: h.queue,
		inference: h.inference,
		now: Date.now,
		port: () => h.port,
	});
	const current = await h.store.write((db) => {
		const row = executionRow(db, started.id)!;
		return ops.active(db, row.id, row.epoch, executionState(row).ordinal);
	});
	expect(current).toBeNull();
	expect(h.get(started.id)).toMatchObject({
		status: "partial",
		result: { code: "execution_source_invalid" },
	});
	expect(h.stats()).toMatchObject({ count: 3, dispatches: 1 });
});
test("restart interrupts a waiting question and clears its pending delivery", async () => {
	const h = await setup([
		plan("lookup"),
		{ name: "find_toolchain", arguments: { query: "lookup" } },
		{ name: "ask_user", arguments: { question: "Which item?" } },
	]);
	const started = await h.start();
	await waitFor(() => h.get(started.id).status === "waiting_user", {
		timeout: 3000,
	});
	expect(h.get(started.id).revision).toBe(0);
	await h.runtime.recover();
	expect(h.get(started.id).status).toBe("interrupted");
	expect(h.get(started.id).question).toBeNull();
	expect(h.stats().dispatches).toBe(0);
});

test("a question answer resumes the same candidate offer without another search and rejects stale or invalid answers", async () => {
	const h = await setup([
		plan("lookup"),
		{ name: "find_toolchain", arguments: { query: "lookup" } },
		{ name: "ask_user", arguments: { question: "Which item?" } },
		invoke("lookup"),
		finish,
	]);
	const work = await h.start();
	await waitFor(() => h.get(work.id).status === "waiting_user", {
		timeout: 3000,
	});
	const questionRef = h.get(work.id).question!.id;
	await expect(
		h.control(work.id, "answer", { questionRef, input: { unexpected: true } }),
	).rejects.toThrow("invalid_answer");
	await expect(
		h.control(work.id, "answer", {
			questionRef: crypto.randomUUID(),
			input: "second",
		}),
	).rejects.toThrow("execution_question_closed");
	await h.control(work.id, "answer", { questionRef, input: "second" });
	await waitFor(() => h.get(work.id).status === "completed", { timeout: 3000 });
	expect(h.stats()).toMatchObject({ searches: 1, dispatches: 1 });
	expect(h.observed[3]!.tools).toContain("lookup");
	expect(h.observed[3]!.tools).not.toContain("find_toolchain");
	expect(h.observed[3]!.context).toContain("second");
	expect(JSON.parse(h.observed[3]!.context).results[0]).toMatchObject({
		state: "user_answer",
		question: "Which item?",
		summary: '"second"',
	});
});
test("a range read records what was read while preserving the background preview outside that range", async () => {
	const reference = {
		ref: "background",
		owner: "memory",
		id: "item",
		revision: "1",
		digest: "digest",
		kind: "memory" as const,
		label: "background",
		preview: "abcdefghijk",
	};
	const h = await setup(
		[
			plan("lookup", "inspect the remaining result"),
			{ name: "find_toolchain", arguments: { query: "lookup" } },
			invoke("lookup"),
			{
				name: "read_reference",
				arguments: { ref: reference.ref, start: 3, limit: 5 },
			},
			invoke("operate", 1),
			finish,
		],
		{ ...done(), references: [reference] },
	);
	const started = await h.start();
	await waitFor(() => h.get(started.id).status === "completed", {
		timeout: 3000,
	});
	const packet = JSON.parse(h.observed[4]!.context);
	expect(
		packet.references.find((ref: { ref: string }) => ref.ref === reference.ref)
			.preview,
	).toBe("abcdefghijk");
	expect(packet.results[1]).toMatchObject({
		summary: "defgh",
		read: { ref: reference.ref, start: 3, limit: 5 },
	});
});
test("a child question resumes with a fresh dispatch identity but keeps its logical child, absolute deadline and remaining budget", async () => {
	const h = await setup(
		[
			plan("lookup"),
			{ name: "find_toolchain", arguments: { query: "lookup" } },
			invoke("lookup"),
			finish,
		],
		{ ...done(), state: "waiting_input", question: "Confirm?", modelCalls: 3 },
	);
	const work = await h.start();
	await waitFor(() => h.get(work.id).status === "waiting_user", {
		timeout: 3000,
	});
	const questionRef = h.get(work.id).question!.id;
	h.setResult({ ...done(), modelCalls: 4 });
	await h.control(work.id, "answer", { questionRef, input: "yes" });
	await waitFor(() => h.get(work.id).status === "completed", { timeout: 3000 });
	expect(h.children).toHaveLength(2);
	const [before, after] = h.children;
	expect(after!.id).toBe(before!.id);
	expect(after!.dispatchId).not.toBe(before!.dispatchId);
	expect(after!.deadline).toBe(before!.deadline);
	expect(after!.modelCalls).toBe(before!.modelCalls - 3);
	expect(after!.usedModelCalls).toBe(3);
	expect(h.stats().searches).toBe(1);
});
test("an amend waits for the old child to stop; an uncertain stop finishes partially without a new write", async () => {
	const h = await setup(
		[
			plan("lookup"),
			{ name: "find_toolchain", arguments: { query: "lookup" } },
			invoke("lookup"),
		],
		{ ...done(), state: "running" },
	);
	const work = await h.start();
	await waitFor(() => h.stats().dispatches === 1, { timeout: 3000 });
	h.port.cancelInTransaction = () => {};
	await h.control(work.id, "amend", { request: "change the target" });
	await h.runtime.reconcile();
	expect(h.get(work.id)).toMatchObject({
		revision: 1,
		status: "waiting_child",
	});
	expect(h.stats().dispatches).toBe(1);
	h.setResult({ ...done(), state: "indeterminate" });
	await h.runtime.reconcile();
	expect(h.get(work.id)).toMatchObject({
		status: "partial",
		result: { code: "operation_indeterminate" },
	});
	expect(h.stats().dispatches).toBe(1);
});
test("source invalidation and a waiting deadline terminate without another inference", async () => {
	for (const invalidate of [true, false]) {
		const h = await setup([
			plan("lookup"),
			{ name: "ask_user", arguments: { question: "What target?" } },
		]);
		const work = await h.start();
		await waitFor(() => h.get(work.id).status === "waiting_user", {
			timeout: 3000,
		});
		if (invalidate) h.invalidate();
		else
			await h.store.write((db) => {
				db.query("UPDATE agent_executions SET deadline=? WHERE id=?").run(
					Date.now() - 1,
					work.id,
				);
			});
		await h.runtime.reconcile();
		expect(h.get(work.id).status).toBe("partial");
		expect(h.stats().count).toBe(2);
	}
});

test("the last parent inference is reserved and exposes only final result functions within the shared 48-call budget", async () => {
	const h = await setup([finish], done(), true),
		work = await h.start();
	await h.store.write((db) => {
		const row = db
			.query("SELECT state_json FROM agent_executions WHERE id=?")
			.get(work.id) as { state_json: string };
		const state = JSON.parse(row.state_json);
		state.calls = 11;
		state.consumed = 47;
		db.query("UPDATE agent_executions SET state_json=? WHERE id=?").run(
			JSON.stringify(state),
			work.id,
		);
	});
	h.run();
	await waitFor(() => h.get(work.id).status === "completed", { timeout: 3000 });
	expect(h.observed[0]!.tools).toEqual(["complete_task", "report_partial"]);
	const state = h.store.read((db) =>
		JSON.parse(
			(
				db
					.query("SELECT state_json FROM agent_executions WHERE id=?")
					.get(work.id) as { state_json: string }
			).state_json,
		),
	);
	expect(state).toMatchObject({ calls: 12, consumed: 48 });
	expect(h.stats().dispatches).toBe(0);
});
test("restart interrupts every unfinished state without replaying queued side effects", async () => {
	for (const status of [
		"queued",
		"deciding",
		"waiting_child",
		"waiting_user",
	]) {
		const h = await setup([], done(), true),
			work = await h.start();
		await h.store.write((db) => {
			db.query("UPDATE agent_executions SET state=? WHERE id=?").run(
				status,
				work.id,
			);
		});
		await h.runtime.recover();
		expect(h.get(work.id)).toMatchObject({
			status: "interrupted",
			result: { code: "backend_restarted" },
		});
		expect(h.stats()).toMatchObject({ count: 0, dispatches: 0 });
	}
});
test("per-conversation capacity rejects the fifth parent before saving another execution or dispatch", async () => {
	const h = await setup([], done(), true);
	for (let i = 0; i < 4; i++) {
		h.source.messageId = `message-${i}`;
		await h.start();
	}
	h.source.messageId = "message-4";
	await expect(h.start()).rejects.toThrow("execution_capacity");
	expect(
		h.store.read(
			(db) =>
				(
					db.query("SELECT count(*) AS n FROM agent_executions").get() as {
						n: number;
					}
				).n,
		),
	).toBe(4);
	expect(h.stats().dispatches).toBe(0);
});

test("the single contract repair reports a safe structural reason and never retries an operation", async () => {
	const h = await setup([
		{ name: "unoffered_function", arguments: {} },
		{
			name: "report_partial",
			arguments: {
				summary: "Cannot continue",
				fulfilled: [],
				missing: ["capability"],
				refs: [],
			},
		},
	]);
	const work = await h.start();
	await waitFor(() => h.get(work.id).status === "partial", { timeout: 3000 });
	expect(h.observed[1]!.context).toContain("execution_tool_not_offered");
	expect(h.stats()).toMatchObject({ count: 2, dispatches: 0, searches: 0 });
});
