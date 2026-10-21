import { expect, test } from "bun:test";
import { waitFor } from "../../../infrastructure/wait-for";
import {
	acceptExecutionPlan,
	executionPlanProjection,
	runnablePlanItems,
} from "../service/execution-plan";
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

test("identical planned items execute independently, while same-item replay returns its receipt and changed input conflicts", async () => {
	const h = await setup([
		plan("create another copy", "create another copy"),
		{ name: "find_toolchain", arguments: { query: "create" } },
		invoke("operate"),
		invoke("operate", 1),
		finish,
	]);
	const work = await h.start();
	await waitFor(() => h.get(work.id).status === "completed", { timeout: 3000 });
	expect(h.children.map((child) => child.request)).toEqual([
		"create another copy",
		"create another copy",
	]);
	expect(new Set(h.children.map((child) => child.id)).size).toBe(2);
	const ops = createExecutionStore({
		store: h.store,
		queue: h.queue,
		inference: h.inference,
		now: Date.now,
		port: () => h.port,
	});
	await h.store.write((db) => {
		const row = executionRow(db, work.id)!,
			state = executionState(row);
		const args = { stepRef: state.plan!.items[0]!.stepRef, contextRefs: [] };
		const receipt = ops.startChild(db, row, state, "toolchain:operate@1", args);
		expect(receipt?.child.id).toBe(h.children[0]!.id);
		expect(receipt?.result?.state).toBe("completed");
		expect(() =>
			ops.startChild(db, row, state, "toolchain:lookup@1", args),
		).toThrow("execution_step_conflict");
		expect(state.children).toBe(2);
		expect(
			db.query("SELECT count(*) AS n FROM agent_execution_steps").get(),
		).toEqual({ n: 2 });
	});
	expect(h.stats().dispatches).toBe(2);
});

test("a revised pending plan preserves executed receipts, invalidates removed step refs, and keeps the remaining budgets", async () => {
	const h = await setup([
		plan("first operation", "old followup"),
		{ name: "find_toolchain", arguments: { query: "operate" } },
		invoke("operate"),
		(context) => ({
			name: "read_reference",
			arguments: { ref: context.results[0]!.refs[0]!, start: 0, limit: 10 },
		}),
		{
			name: "set_plan",
			arguments: {
				goal: "goal",
				report: "report",
				items: [
					{ request: "new followup from the result", check: "", dependsOn: [] },
				],
			},
		},
		invoke("operate", 1),
		finish,
	]);
	const work = await h.start();
	await waitFor(() => h.get(work.id).status === "completed", { timeout: 3000 });
	// A completed item continues the plan; the range read is the new observation that reopens it.
	expect(h.observed[3]!.tools).not.toContain("set_plan");
	expect(h.observed[4]!.tools).toContain("set_plan");
	const before = JSON.parse(h.observed[4]!.context).plan;
	const after = JSON.parse(h.observed[5]!.context).plan;
	expect(after.revision).toBe(2);
	expect(after.requestRevision).toBe(0);
	expect(after.executed[0]).toEqual(before.executed[0]);
	expect(after.steps[1].stepRef).not.toBe(before.steps[1].stepRef);
	expect(h.children.map((child) => child.request)).toEqual([
		"first operation",
		"new followup from the result",
	]);
	expect(JSON.parse(h.observed[5]!.context)).toMatchObject({
		callsLeft: 7,
		childCallsLeft: 5,
		modelCallsLeft: 42,
		searchesLeft: 2,
	});
	expect(h.stats()).toMatchObject({ count: 7, searches: 1, dispatches: 2 });
});

test("unknown, removed and dependency-blocked steps are rejected before dispatch; completed plans offer no new effects", async () => {
	const h = await setup([], done(), true),
		work = await h.start();
	const state = h.store.read((db) =>
		executionState(executionRow(db, work.id)!),
	);
	acceptExecutionPlan(state, 0, plan("first", "second").arguments);
	const first = state.plan!.items[0]!,
		second = state.plan!.items[1]!;
	const parse = (stepRef: string) =>
		parseExecutionDecision(
			[
				{
					id: "call",
					name: "lookup",
					arguments: JSON.stringify({ stepRef, contextRefs: [] }),
				},
			],
			executionTools(state, [card("lookup")]),
			[card("lookup")],
			[],
		);
	expect(runnablePlanItems(state).map((item) => item.stepRef)).toEqual([
		first.stepRef,
	]);
	for (const ref of ["unknown", second.stepRef])
		expect(() => parse(ref)).toThrow("execution_step_not_offered");
	expect(
		executionTools(state, []).map((tool) => tool.function.name),
	).not.toContain("set_plan");
	expect(() =>
		acceptExecutionPlan(state, 0, {
			goal: "goal",
			report: "report",
			items: [{ request: "premature", check: "", dependsOn: [] }],
		}),
	).toThrow("execution_plan_observation_required");
	state.searches++;
	acceptExecutionPlan(state, 0, {
		goal: "goal",
		report: "report",
		items: [{ request: "replacement", check: "", dependsOn: [] }],
	});
	expect(() => parse(first.stepRef)).toThrow("execution_step_not_offered");
	state.plan!.items[0]!.inputDigest = "digest";
	state.plan!.items[0]!.resultRef = "result";
	expect(
		executionTools(state, [card("lookup")]).map((tool) => tool.function.name),
	).toEqual(["complete_task", "report_partial"]);
	expect(() =>
		acceptExecutionPlan(state, 0, {
			goal: "goal",
			report: "report",
			items: [{ request: "extra", check: "", dependsOn: [] }],
		}),
	).toThrow("execution_plan_closed");
});

test("plan structural conflicts never alter the accepted plan or reset counters", async () => {
	const h = await setup([], done(), true),
		work = await h.start();
	const state = h.store.read((db) =>
		executionState(executionRow(db, work.id)!),
	);
	acceptExecutionPlan(state, 0, plan("first").arguments);
	state.children = 5;
	state.calls = 9;
	state.consumed = 40;
	state.searches++;
	const before = structuredClone(state);
	for (const input of [
		{
			goal: "goal",
			report: "report",
			items: [
				{
					request: "pending dependency",
					check: "",
					dependsOn: [state.plan!.items[0]!.stepRef],
				},
			],
		},
		{
			goal: "goal",
			report: "report",
			items: [{ request: "self cycle", check: "", dependsOn: [0] }],
		},
		{
			goal: "goal",
			report: "report",
			items: [
				{ request: "forward", check: "", dependsOn: [1] },
				{ request: "other", check: "", dependsOn: [] },
			],
		},
		{
			goal: "goal",
			report: "report",
			items: [
				{ request: "too many", check: "", dependsOn: [] },
				{ request: "other", check: "", dependsOn: [] },
			],
		},
	]) {
		expect(() => acceptExecutionPlan(state, 0, input)).toThrow();
		expect(state).toEqual(before);
	}
});

test("an amended request requires a new plan while preserving past receipts as facts rather than automatically satisfying the new request", async () => {
	const h = await setup([
		plan("old operation", "old remaining operation"),
		{ name: "find_toolchain", arguments: { query: "operate" } },
		invoke("operate"),
		{ name: "ask_user", arguments: { question: "Continue?" } },
		{
			name: "set_plan",
			arguments: {
				goal: "goal",
				report: "report",
				items: [
					{ request: "amended remaining operation", check: "", dependsOn: [] },
				],
			},
		},
		invoke("operate", 1),
		finish,
	]);
	const work = await h.start();
	await waitFor(() => h.get(work.id).status === "waiting_user", {
		timeout: 3000,
	});
	const deadline = h.get(work.id).deadline;
	await h.control(work.id, "amend", {
		request: "keep the first and change the remaining operation",
	});
	await waitFor(() => h.get(work.id).status === "completed", { timeout: 3000 });
	expect(h.observed[4]!.tools).toEqual(["set_plan", "report_partial"]);
	const packet = JSON.parse(h.observed[5]!.context);
	expect(packet.plan).toMatchObject({ revision: 2, requestRevision: 1 });
	expect(packet.plan.executed[0]).toMatchObject({
		state: "executed",
		request: "old operation",
	});
	expect(packet.plan.pending[0]).toEqual({
		request: "amended remaining operation",
		check: "",
		dependsOn: [],
	});
	expect(h.children.map((child) => [child.request, child.revision])).toEqual([
		["old operation", 0],
		["amended remaining operation", 1],
	]);
	expect(h.get(work.id).deadline).toBe(deadline);
	expect(h.stats().dispatches).toBe(2);
});

test("candidate selection keeps its frozen offer until a child result; a later revision can remove unnecessary pending work", async () => {
	const h = await setup([], done(), true),
		work = await h.start();
	const state = h.store.read((db) =>
		executionState(executionRow(db, work.id)!),
	);
	expect(() =>
		acceptExecutionPlan(state, 0, {
			goal: "goal",
			items: [],
			report: "report",
		}),
	).toThrow("execution_plan_invalid");
	acceptExecutionPlan(state, 0, plan("perform", "possible followup").arguments);
	state.searches++;
	state.selecting = true;
	expect(
		executionTools(state, [card("lookup")]).map((tool) => tool.function.name),
	).not.toContain("set_plan");
	expect(() =>
		acceptExecutionPlan(state, 0, {
			goal: "goal",
			items: [],
			report: "report",
		}),
	).toThrow("execution_plan_observation_required");
	state.selecting = false;
	const first = state.plan!.items[0]!;
	first.inputDigest = "digest";
	first.resultRef = "receipt";
	first.resultState = "completed";
	state.notes.push({
		id: first.childId,
		state: "completed",
		summary: "covers the goal",
		refs: ["receipt"],
	});
	state.children = 1;
	expect(
		executionTools(state, [card("lookup")]).map((tool) => tool.function.name),
	).not.toContain("set_plan");
	expect(() =>
		acceptExecutionPlan(state, 0, {
			goal: "goal",
			items: [],
			report: "report",
		}),
	).toThrow("execution_plan_observation_required");
	state.notes.at(-1)!.state = "failed";
	expect(
		executionTools(state, [card("lookup")]).map((tool) => tool.function.name),
	).toContain("set_plan");
	state.notes.at(-1)!.state = "completed";
	state.notes.push({
		id: "read:1",
		state: "reference",
		summary: "range read",
		refs: ["receipt"],
		read: { ref: "receipt", start: 0, limit: 10 },
	});
	acceptExecutionPlan(state, 0, { goal: "goal", items: [], report: "report" });
	expect(state.plan!.items).toEqual([first]);
	expect(state.plan!.revision).toBe(2);
	expect(state.children).toBe(1);
	expect(
		executionTools(state, [card("lookup")]).map((tool) => tool.function.name),
	).toEqual(["complete_task", "report_partial"]);
});

test("a revision depends on executed items by stepRef, never on pending items, and the host owns the plan version", async () => {
	const h = await setup([], done(), true),
		work = await h.start();
	const state = h.store.read((db) =>
		executionState(executionRow(db, work.id)!),
	);
	acceptExecutionPlan(state, 0, plan("perform", "followup").arguments);
	const [first, second] = state.plan!.items;
	first!.inputDigest = "digest";
	first!.resultRef = "receipt";
	first!.resultState = "completed";
	state.notes.push({
		id: first!.childId,
		state: "completed",
		summary: "done",
		refs: ["receipt"],
	});
	state.children = 1;
	state.notes.push({
		id: "read:1",
		state: "reference",
		summary: "range read",
		refs: ["receipt"],
		read: { ref: "receipt", start: 0, limit: 10 },
	});
	const tool = executionTools(state, [card("lookup")]).find(
		(t) => t.function.name === "set_plan",
	)!;
	const call = (input: Record<string, unknown>) =>
		parseExecutionDecision(
			[{ id: "call", name: "set_plan", arguments: JSON.stringify(input) }],
			[tool],
			[],
			[],
		);
	expect(() =>
		call({
			goal: "goal",
			items: [{ request: "x", check: "", dependsOn: [second!.stepRef] }],
			report: "report",
		}),
	).toThrow("execution_plan_invalid");
	expect(() =>
		call({
			expectedPlanRevision: 1,
			goal: "goal",
			items: [],
			report: "report",
		}),
	).toThrow("execution_plan_arguments_invalid");
	const accepted = call({
		goal: "goal",
		items: [
			{
				request: "use the result",
				check: "matches",
				dependsOn: [first!.stepRef],
			},
			{ request: "after", check: "", dependsOn: [0] },
		],
		report: "report",
	});
	acceptExecutionPlan(state, 0, accepted.arguments);
	const [, revised, after] = state.plan!.items;
	expect(state.plan).toMatchObject({
		revision: 2,
		goal: "goal",
		report: "report",
	});
	expect(revised).toMatchObject({
		request: "use the result",
		check: "matches",
		dependsOn: [first!.stepRef],
	});
	expect(after!.dependsOn).toEqual([revised!.stepRef]);
	expect(runnablePlanItems(state)).toEqual([revised!]);
});

test("the plan projection keeps pending dependencies copyable and does not call an in-flight item executed", async () => {
	const h = await setup([], done(), true),
		work = await h.start();
	const state = h.store.read((db) =>
		executionState(executionRow(db, work.id)!),
	);
	acceptExecutionPlan(state, 0, {
		goal: "goal",
		report: "report",
		items: [
			{ request: "first", check: "a", dependsOn: [] },
			{ request: "second", check: "b", dependsOn: [0] },
			{ request: "third", check: "c", dependsOn: [1] },
		],
	});
	const [first, second] = state.plan!.items;
	first!.inputDigest = "digest";
	const inflight = executionPlanProjection(state);
	expect(inflight.executed).toEqual([]);
	expect(inflight.steps.map((step) => step.state)).toEqual([
		"running",
		"pending",
		"pending",
	]);
	expect(inflight.pending).toEqual([
		{ request: "second", check: "b", dependsOn: [first!.stepRef] },
		{ request: "third", check: "c", dependsOn: [0] },
	]);
	first!.resultRef = "result:1";
	first!.resultState = "completed";
	const settled = executionPlanProjection(state);
	expect(settled.executed).toEqual([
		{
			stepRef: first!.stepRef,
			request: "first",
			check: "a",
			state: "executed",
			resultRef: "result:1",
			resultState: "completed",
		},
	]);
	expect(settled.pending).toEqual([
		{ request: "second", check: "b", dependsOn: [first!.stepRef] },
		{ request: "third", check: "c", dependsOn: [0] },
	]);
	expect(settled.steps[1]!.stepRef).toBe(second!.stepRef);
	expect(Object.keys(settled.pending[0]!).sort()).toEqual([
		"check",
		"dependsOn",
		"request",
	]);
});

test("a failed prerequisite keeps its dependents closed and offers no search until a revision reopens the work", async () => {
	const h = await setup([], done(), true),
		work = await h.start();
	const state = h.store.read((db) =>
		executionState(executionRow(db, work.id)!),
	);
	acceptExecutionPlan(state, 0, plan("lookup", "use the lookup").arguments);
	const [first, second] = state.plan!.items;
	first!.inputDigest = "digest";
	first!.resultRef = "receipt";
	first!.resultState = "failed";
	state.notes.push({
		id: first!.childId,
		state: "failed",
		summary: "failed",
		refs: ["receipt"],
	});
	state.children = 1;
	expect(runnablePlanItems(state)).toEqual([]);
	const names = executionTools(state, [card("lookup")]).map(
		(tool) => tool.function.name,
	);
	expect(names).not.toContain("find_toolchain");
	expect(names).not.toContain("lookup");
	expect(names).toContain("set_plan");
	const tool = executionTools(state, []).find(
		(t) => t.function.name === "set_plan",
	)!;
	expect(() =>
		parseExecutionDecision(
			[
				{
					id: "call",
					name: "set_plan",
					arguments: JSON.stringify({
						goal: "goal",
						items: [{ request: "x", check: "", dependsOn: [first!.stepRef] }],
						report: "report",
					}),
				},
			],
			[tool],
			[],
			[],
		),
	).toThrow("execution_plan_invalid");
	acceptExecutionPlan(state, 0, {
		goal: "goal",
		items: [
			{ request: "retry the lookup", check: "", dependsOn: [] },
			{ request: second!.request, check: "", dependsOn: [0] },
		],
		report: "report",
	});
	const retry = state.plan!.items[1]!;
	expect(runnablePlanItems(state)).toEqual([retry]);
	expect(
		executionTools(state, [card("lookup")]).map((t) => t.function.name),
	).toContain("find_toolchain");
});

test("a plan blocked by a failure reopens revision after an unrelated completion, and shows the failed dependency apart", async () => {
	const h = await setup([], done(), true),
		work = await h.start();
	const state = h.store.read((db) =>
		executionState(executionRow(db, work.id)!),
	);
	acceptExecutionPlan(state, 0, {
		goal: "goal",
		items: [
			{ request: "a", dependsOn: [], check: "" },
			{ request: "b", dependsOn: [0], check: "" },
			{ request: "c", dependsOn: [], check: "" },
		],
		report: "report",
	});
	const [a, b, c] = state.plan!.items;
	for (const [item, result] of [
		[a!, "failed"],
		[c!, "completed"],
	] as const) {
		item.inputDigest = "digest";
		item.resultRef = `result:${item.childId}`;
		item.resultState = result;
		state.notes.push({
			id: item.childId,
			state: result,
			summary: result,
			refs: [item.resultRef],
		});
	}
	state.children = 2;
	expect(runnablePlanItems(state)).toEqual([]);
	expect(
		executionTools(state, [card("lookup")]).map((t) => t.function.name),
	).toContain("set_plan");
	const projection = executionPlanProjection(state);
	expect(projection.pending).toEqual([
		{ request: "b", dependsOn: [], check: "", blockedBy: [a!.stepRef] },
	]);
	expect(b!.dependsOn).toEqual([a!.stepRef]);
	state.planRequired = true;
	const replacing = executionPlanProjection(state);
	expect(replacing.pending).toEqual([]);
	expect(replacing).not.toHaveProperty("goal");
	expect(replacing.executed.map((item) => item.stepRef)).toEqual([
		a!.stepRef,
		c!.stepRef,
	]);
});

test("the existing one-time repair explains plan schema fields without accepting model-authored progress", async () => {
	const h = await setup([
		{
			name: "set_plan",
			arguments: {
				goal: "goal",
				report: "report",
				items: [
					{ request: "lookup", check: "", dependsOn: [], state: "executed" },
				],
			},
		},
		plan("lookup"),
		{ name: "find_toolchain", arguments: { query: "lookup" } },
		invoke("lookup"),
		finish,
	]);
	const work = await h.start();
	await waitFor(() => h.get(work.id).status === "completed", { timeout: 3000 });
	const repair = JSON.parse(h.observed[1]!.context).contractError;
	expect(repair).toContain("execution_plan_arguments_invalid");
	expect(repair).toContain("Omit stepRef, state and result fields");
	expect(h.stats()).toMatchObject({ count: 5, searches: 1, dispatches: 1 });
});
