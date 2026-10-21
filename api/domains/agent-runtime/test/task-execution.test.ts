import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openStore } from "../../../infrastructure/sqlite";
import { waitFor } from "../../../infrastructure/wait-for";
import { createQueue, migrations as queueMigrations } from "../../queue";
import { migrations } from "../repository";
import { hash, type ToolchainCard } from "../../capabilities";
import type { InferencePort, Receipt } from "../../inference";
import type { ChildResult, ToolchainExecutionPort } from "../../tool-runtime";
import { createTaskExecutions } from "../service/executions";
import {
	acceptExecutionPlan,
	runnablePlanItems,
} from "../service/execution-plan";
import { createExecutionStore } from "../service/execution-store";
import { executionRow, executionState } from "../repository/executions";
import {
	executionTools,
	parseExecutionDecision,
} from "../service/execution-tools";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const clean of cleanups.splice(0)) await clean();
});
type Call = { name: string; arguments: Record<string, unknown> };
type DecisionContext = {
	results: Array<{ refs: string[] }>;
	plan: { revision: number; items: Array<{ stepRef: string }> };
};
const done = (summary = "confirmed"): ChildResult => ({
	state: "completed",
	ref: { id: "receipt" },
	summary,
	modelCalls: 1,
	references: [],
});
function card(id: string): ToolchainCard {
	return {
		id,
		revisionId: `toolchain:${id}@1`,
		functionName: id,
		title: id,
		summary: id,
		useWhen: [id],
		avoidWhen: [],
		examples: [],
		redirects: [],
		score: { similarity: 1, ftsRank: null, history: false },
	} as unknown as ToolchainCard;
}
async function setup(
	calls: Array<Call | ((context: DecisionContext) => Call)>,
	initial = done(),
	defer = false,
) {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-execution-"));
	const store = openStore(join(dir, "db"), [...queueMigrations, ...migrations]);
	const queue = createQueue(store);
	const observed: Array<{ tools: string[]; context: string }> = [];
	const children: import("../../tool-runtime").ChildExecution[] = [];
	let count = 0,
		dispatches = 0,
		cancels = 0,
		searches = 0,
		valid = true,
		result = initial;
	const inference = {
		captureUserControlInTransaction: () => crypto.randomUUID(),
		acceptInTransaction: () => true,
		executeStream: async (
			requestId: string,
			messages: Array<{ content: string }>,
			_signal: AbortSignal,
			_delta: unknown,
			_prep: unknown,
			tools: Array<{ function: { name: string } }>,
		) => {
			observed.push({
				tools: tools.map((t) => t.function.name),
				context: messages.at(-1)!.content,
			});
			const decision = calls[count++];
			if (!decision) throw new Error("fixture_calls_exhausted");
			const call =
				typeof decision === "function"
					? decision(JSON.parse(messages.at(-1)!.content))
					: decision;
			return {
				requestId,
				attemptId: crypto.randomUUID(),
				value: "",
				toolCalls: [
					{
						id: crypto.randomUUID(),
						name: call.name,
						arguments: JSON.stringify(call.arguments),
					},
				],
			} as Receipt;
		},
	} as unknown as InferencePort;
	const runtime = createTaskExecutions({
		store,
		queue,
		inference,
		now: Date.now,
	});
	const cards = [card("lookup"), card("operate")];
	const port: ToolchainExecutionPort = {
		validSourceInTransaction: () => valid,
		validReferenceInTransaction: () => valid,
		controlSourceInTransaction: (_db, _conversationId, messageId) => ({
			messageId,
			request: "updated request",
			digest: hash("updated request"),
		}),
		readReferenceInTransaction: (_db, _source, ref, start, limit) =>
			ref.preview.slice(start, start + limit),
		cardInTransaction: (_db, revision) =>
			cards.find((c) => c.revisionId === revision),
		find: async () => {
			searches++;
			return cards;
		},
		prepareInTransaction: () => null,
		execute: async (_prepared, child) => {
			children.push(structuredClone(child));
			dispatches++;
			return result;
		},
		currentInTransaction: () => result,
		adoptInTransaction: () => valid,
		cancelInTransaction: () => {
			cancels++;
			result = { ...result, state: "cancelled" };
		},
		validateAnswerInTransaction: (_db, _child, _result, input) =>
			typeof input === "string",
		flush: () => {},
		deliverInTransaction: () => true,
		controlInTransaction: () => ({
			revisionId: "binding:task.execute@1",
			instructions: "fixture",
			runMs: 300_000,
			limits: { parentCalls: 12, childCalls: 6, searches: 3, modelCalls: 48 },
		}),
	};
	runtime.configure(port);
	const source = {
		conversationId: "conversation",
		messageId: "message",
		runId: "real-source-run",
		request: "find an item and use the result",
		digest: hash("find an item and use the result"),
	};
	const start = () =>
		store.write((db) =>
			runtime.startInTransaction(db, {
				source,
				request: source.request,
				references: [],
			}),
		);
	const get = (id: string) =>
		store.read((db) => runtime.viewInTransaction(db, id)!);
	const control = (id: string, action: string, extra = {}) =>
		store.write((db) =>
			runtime.controlInTransaction(
				db,
				source.conversationId,
				{ workRef: id, expectedRevision: get(id).revision, action, ...extra },
				"answer-message",
			),
		);
	cleanups.push(async () => {
		await runtime.close();
		await queue.close();
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	});
	const run = () => {
		runtime.start();
		queue.start();
	};
	if (!defer) run();
	return {
		store,
		inference,
		port,
		run,
		source,
		children,
		runtime,
		queue,
		start,
		get,
		control,
		observed,
		stats: () => ({ count, dispatches, cancels, searches }),
		setResult: (r: ChildResult) => {
			result = r;
		},
		invalidate: () => {
			valid = false;
		},
	};
}
const finish = (context: DecisionContext): Call => ({
	name: "complete_task",
	arguments: {
		summary: "All confirmed",
		fulfilled: ["done"],
		missing: [],
		refs: context.results.flatMap((result) => result.refs),
	},
});
const plan = (...requests: string[]): Call => ({
	name: "set_plan",
	arguments: {
		goal: requests.join(" / "),
		items: requests.map((request, index) => ({
			request,
			check: "",
			dependsOn: index ? [index - 1] : [],
		})),
		report: "summarize the results",
	},
});
const invoke =
	(name: string, index = 0, contextRefs: string[] = []) =>
	(context: DecisionContext): Call => ({
		name,
		arguments: { stepRef: context.plan.items[index]!.stepRef, contextRefs },
	});
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
			name: "set_plan",
			arguments: {
				goal: "goal",
				report: "report",
				items: [
					{ request: "new followup from the result", check: "", dependsOn: [] },
				],
			},
		}),
		invoke("operate", 1),
		finish,
	]);
	const work = await h.start();
	await waitFor(() => h.get(work.id).status === "completed", { timeout: 3000 });
	const before = JSON.parse(h.observed[3]!.context).plan;
	const after = JSON.parse(h.observed[4]!.context).plan;
	expect(after.revision).toBe(2);
	expect(after.requestRevision).toBe(0);
	expect(after.items[0]).toEqual(before.items[0]);
	expect(after.items[1].stepRef).not.toBe(before.items[1].stepRef);
	expect(h.children.map((child) => child.request)).toEqual([
		"first operation",
		"new followup from the result",
	]);
	expect(JSON.parse(h.observed[4]!.context)).toMatchObject({
		callsLeft: 8,
		childCallsLeft: 5,
		modelCallsLeft: 43,
		searchesLeft: 2,
	});
	expect(h.stats()).toMatchObject({ count: 6, searches: 1, dispatches: 2 });
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
		(context) => ({
			name: "set_plan",
			arguments: {
				goal: "goal",
				report: "report",
				items: [
					{ request: "amended remaining operation", check: "", dependsOn: [] },
				],
			},
		}),
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
	expect(packet.plan.items[0]).toMatchObject({
		state: "executed",
		request: "old operation",
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
