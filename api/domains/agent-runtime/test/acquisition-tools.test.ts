import { afterEach, expect, test } from "bun:test";
import { URL_A, coldPackage, harness, searchBind } from "./route-harness";

const open: Awaited<ReturnType<typeof harness>>[] = [];
afterEach(async () => {
	for (const h of open.splice(0)) await h.close();
});
async function setup() {
	const h = await harness();
	open.push(h);
	return h;
}
const jobRow = (h: Awaited<ReturnType<typeof harness>>, id: string) =>
	h.store.read((db) => h.queue.getInTransaction(db, id));

test("A02 cold: worker initialization performs the first REAL lookup with the spec keywords; no model call, no LLM slot", async () => {
	const h = await setup();
	h.proposals.push({
		kind: "search-first",
		proposalToken: "p1",
		query: "天気予報 鎌倉",
		language: "ja",
		region: "JP",
	});
	h.binds.set("p1", searchBind());
	const root = await h.start("run-1");
	const job = await jobRow(h, root.jobId);
	expect(job).toBeNull();

	// first lookup used the keywords; nothing else was fetched
	expect(h.started).toEqual([
		{
			toolId: "web.lookup",
			args: { query: "天気予報 鎌倉", language: "ja", region: "JP" },
			grantedUrl: undefined,
			attemptTimeoutMs: undefined,
		},
	]);
	expect(h.captures).toEqual([]); // no fake inference receipt, no control capture
	const rootTask = h.task(root.taskId);
	expect(rootTask.state).toBe("waiting_child");
	expect(rootTask.model_calls).toBe(0);
	const [child] = h.agents.list("run-1").filter((t) => t.kind === "worker");
	const c = h.task(child!.id);
	expect(c.state).toBe("waiting_tool");
	expect(c.phase).toBe("search");
	expect(c.tool_calls).toBe(1);
	expect(c.model_calls).toBe(0);
	expect(c.package_revision_id).toBe(coldPackage);
	const binding = h.agents.bindingInTransaction as unknown;
	expect(binding).toBeDefined();
	expect(child!.acquisitionMode).toBe("search");
	await h.store.read((db) => {
		const b = h.agents.bindingInTransaction(db, c.id)!;
		expect(b.lookupProvenance).toMatchObject({
			origin: "lookup",
			query: "天気予報 鎌倉",
			runId: "run-1",
		});
		const steps = db
			.query(
				"SELECT action_origin,action_kind,state FROM agent_steps WHERE task_id=?",
			)
			.all(root.taskId);
		expect(steps).toEqual([]);
	});
});

test("A02 duplicate start keeps one child and performs no second acquisition", async () => {
	const h = await setup();
	h.proposals.push({
		kind: "search-first",
		proposalToken: "p1",
		query: "q",
		language: "ja",
		region: "JP",
	});
	h.binds.set("p1", searchBind());
	const root = await h.start("run-1");
	const repeated = await h.start("run-1");
	expect(repeated.taskId).toBe(root.taskId);
	expect(h.started.length).toBe(1);
});

test("a cold source mismatch preserves the structural repair allowance and the same child budget", async () => {
	const h = await setup();
	h.proposals.push({
		kind: "search-first",
		proposalToken: "p1",
		query: "q",
		language: "ja",
		region: "JP",
	});
	h.binds.set("p1", searchBind());
	await h.start("run-1");
	const child = h.agents.list("run-1").find((t) => t.kind === "worker")!;
	const deadline = h.task(child.id).deadline;
	h.results.set("op1", h.doc("SENTINEL_TARGET 27"));
	await h.agents.reconcile();
	h.setObservation({ kind: "source_unusable", code: "wrong_source" });
	await h.runModelStep(child.id, {
		action: "finish",
		report: {
			summary: "27",
			claims: [{ text: "27", evidence: ["e1"] }],
			limitations: [],
		},
	});
	expect(h.task(child.id)).toMatchObject({
		state: "queued",
		json_repairs: 0,
		model_calls: 1,
		deadline,
	});
	const { prep } = await h.runModelStep(child.id, {
		action: "invoke",
		tool: "nonexistent",
		arguments: {},
	});
	if (prep.status !== "ready") throw new Error("worker_not_ready");
	expect(JSON.parse(prep.input.messages[1]!.content).lastResult).toEqual({
		code: "source_unusable",
	});
	expect(h.task(child.id).json_repairs).toBe(1);
});

test("A02 the child keeps its own executionRefs: foreign owners cannot use them and the legacy hint is not applied", async () => {
	const h = await setup();
	h.proposals.push({
		kind: "search-first",
		proposalToken: "p1",
		query: "q",
		language: "ja",
		region: "JP",
	});
	h.binds.set("p1", searchBind());
	const _root = await h.start("run-1");

	const child = h.agents.list("run-1").find((t) => t.kind === "worker")!;
	// lookup completes with hits → the child's own model step sees the snippets, with no forecast hint
	h.results.set("op1", {
		state: "succeeded",
		result: {
			observedAt: new Date().toISOString(),
			hits: [{ url: URL_A, title: "t", snippet: "鎌倉 晴れ" }],
			documents: [],
			failures: [],
		},
	});
	await h.agents.reconcile();
	expect(h.task(child.id).state).toBe("queued");
	const { prep } = await h.runModelStep(child.id, {
		action: "finish",
		report: {
			summary: "x",
			claims: [{ text: "x", evidence: [{ sourceId: "none", quote: "none" }] }],
			limitations: [],
		},
	});
	expect(prep.status).toBe("ready");
	const user = (prep as { input: { messages: { content: string }[] } }).input
		.messages[1]!.content;
	// The host may suggest this child's observed lookup hit, never the legacy
	// structured forecast hint or a foreign owner's execution reference.
	expect(JSON.parse(user).nextInvocation).toBeUndefined();
	expect(JSON.parse(user).observations[0].url).toBe(URL_A);
	expect(h.captures.length).toBe(1); // exactly the child's own summary/decision call
});

test("A02 candidate: import yields an observation owned by the child, not a real lookup; counts as one lookup allowance", async () => {
	const h = await setup();
	h.proposals.push({ kind: "candidate", proposalToken: "p1" });
	h.binds.set("p1", {
		kind: "bound",
		bindingToken: "tok-c",
		packageRevisionId: coldPackage,
		initialAction: {
			kind: "candidate-import",
			query: "天気予報 鎌倉",
			searchedAt: Date.now() - 1000,
			provenanceDigest: "e".repeat(64),
			hits: [{ url: URL_A, title: "t", snippet: "s" }],
			provenance: {
				origin: "candidate-cache",
				runId: "old",
				stepId: "old-step",
				query: "天気予報 鎌倉",
				searchedAt: Date.now() - 1000,
				provider: "web-research",
				digest: "e".repeat(64),
			},
		},
	});
	const _root = await h.start("run-1");
	// the candidate hit URL must be authorized by the route port for this binding

	const child = h.agents.list("run-1").find((t) => t.kind === "worker")!;
	expect(h.started.length).toBe(0);
	const c = h.task(child.id);
	expect(c.state).toBe("queued");
	expect(c.tool_calls).toBe(1);
	expect(child.acquisitionMode).toBe("candidate");
	await h.store.read((db) => {
		expect(
			h.agents.bindingInTransaction(db, c.id)!.lookupProvenance,
		).toMatchObject({ origin: "candidate-cache", stepId: "old-step" });
	});
});

test("A02 unmatched starts the shared worker loop; clarification/unavailable end without a child", async () => {
	const h = await setup();
	h.proposals.push({ kind: "unmatched" });
	const _root = await h.start("run-1", "東京の天気");

	const t = h.task(h.agents.list("run-1").find((t) => t.kind === "worker")!.id);
	expect(t.state).toBe("queued");
	const job = await jobRow(h, t.job_id!);
	expect(job?.kind).toBe("agent.step");
	expect(job?.resourceKey).toBe("inference.llm");

	h.proposals.length = 0;
	h.proposals.push({ kind: "clarification", question: "静岡市ですか?" });
	const r2 = await h.start("run-2", "天気予報 静岡");

	expect(h.task(r2.taskId).state).toBe("ready_for_answer");
	expect(h.task(r2.taskId).error_code).toBe("clarification_required");
	expect(JSON.parse(h.task(r2.taskId).input_json!).clarificationQuestion).toBe(
		"静岡市ですか?",
	);

	h.proposals.length = 0;
	h.proposals.push({ kind: "unavailable", code: "route_disabled" });
	const r3 = await h.start("run-3");

	expect(h.task(r3.taskId).state).toBe("ready_for_answer");
	expect(h.task(r3.taskId).error_code).toBe("route_disabled");
	expect(h.agents.list("run-3").filter((x) => x.kind === "worker")).toEqual([]);
	expect(h.started.length).toBe(0);
});

test("A02 a bind or capability failure is an explicit failure, never a silent different route", async () => {
	const h = await setup();
	h.proposals.push({
		kind: "search-first",
		proposalToken: "p1",
		query: "q",
		language: "ja",
		region: "JP",
	});
	h.binds.set("p1", { kind: "rejected", code: "route_disabled" });
	const root = await h.start("run-1");

	const t = h.task(root.taskId);
	expect(t.state).toBe("ready_for_answer");
	expect(t.error_code).toBe("route_disabled");
	expect(h.started.length).toBe(0);
	expect(h.agents.list("run-1").filter((x) => x.kind === "worker")).toEqual([]);
});
