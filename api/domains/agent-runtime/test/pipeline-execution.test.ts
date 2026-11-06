import { expect, test } from "bun:test";
import type { ComponentRecord, PipelineDefinition } from "eumenes-pipeline";
import type { Receipt } from "../../inference";
import { waitFor } from "../../../infrastructure/wait-for";
import { done, setup } from "./task-execution-harness";
const record = (entry: string): ComponentRecord => ({
	card: {
		entry,
		bundle: entry,
		title: entry,
		summary: entry,
		useWhen: [],
		avoidWhen: [],
		effects: [],
		mayAskUser: false,
		output: { schemaRef: null, origin: "missing" },
	},
	execution: "command",
	enabled: true,
	support: "partial",
	reasons: [],
	evidence: {
		toolchainRevisionId: `toolchain:${entry}@1`,
		definitionHash: null,
		packageRevisionId: null,
		bindingRevisionId: null,
		bindingDigest: null,
		adapterRef: null,
		bundleSource: null,
		toolRevisionIds: [],
		inputSchemaRefs: [],
		outputSchemaRef: null,
		inputOrigin: "missing",
	},
});
async function fixture(outputs: unknown[]) {
	const h = await setup([], done("confirmed"), true),
		seen: Array<Record<string, unknown>> = [];
	h.port.pipelineInTransaction = () => ({
		bindingRevisionId: "binding:pipeline.execute@2",
		instructions: "Return the short authoring outcome",
		runMs: 300000,
	});
	h.port.pipelineCatalogInTransaction = () => [
		record("lookup"),
		record("operate"),
	];
	h.port.stepToolchainInTransaction = (_db, id) => `toolchain:${id}@1`;
	let calls = 0;
	h.inference.executeStream = async (requestId, messages) => {
		seen.push(JSON.parse(messages.at(-1)!.content));
		const value = outputs[calls++];
		if (value === undefined) throw new Error("fixture_calls_exhausted");
		return {
			requestId,
			attemptId: crypto.randomUUID(),
			value: JSON.stringify(value),
		} as Receipt;
	};
	const definition: PipelineDefinition = {
		request: h.source.request,
		steps: [
			{
				id: "find-source",
				bundle: "lookup",
				task: "find",
				from: ["request"],
				result: "source",
			},
			{
				id: "use-source",
				bundle: "operate",
				task: "use",
				from: ["find-source"],
				result: "delivered",
			},
		],
		output: { from: ["use-source"], deliver: "show final result" },
	};
	const start = (
		references: import("../../tool-runtime").ExecutionReference[] = [],
	) =>
		h.store.write((db) =>
			h.runtime.startPipelineInTransaction(db, {
				source: h.source,
				toolchainRevisionId: "toolchain:pipeline.execute@1",
				references,
			}),
		);
	return { ...h, definition, start, seen, calls: () => calls };
}

test("one-off definition uses pinned entries, declared references, selected final links", async () => {
	const h = await fixture([]);
	const d = h.definition;
	h.inference.executeStream = async (requestId) => ({
		requestId,
		attemptId: crypto.randomUUID(),
		value: JSON.stringify({ status: "ready", definition: d }),
	});
	const first = { ...done("first"), links: ["resource://image/intermediate"] };
	h.port.execute = async (_prepared, child) => {
		h.children.push(structuredClone(child));
		const result =
			h.children.length === 1
				? first
				: { ...done("final"), links: ["resource://image/final"] };
		h.setResult(result);
		return result;
	};
	const started = await h.start();
	expect((await h.start()).id).toBe(started.id);
	h.run();
	await waitFor(() => h.children.length === 2);
	expect(h.children[0]!.chainRevisionId).toBe("toolchain:lookup@1");
	expect(
		h.children[1]!.refs.some(
			(r) => r.kind === "result" && r.id === h.children[0]!.id,
		),
	).toBe(true);
	await waitFor(() => h.get(started.id).status === "completed");
	const result = h.get(started.id).result!;
	expect(result.refs.some((ref) => ref === `result:${h.children[0]!.id}`)).toBe(
		false,
	);
	expect(result.refs).toContain(`result:${h.children[1]!.id}`);
	expect(result.links).toEqual(["resource://image/final"]);
	expect(result.summary).toContain("final");
	expect(result.summary).not.toContain("first");
});

test("a model-modified request is bound to the original without a repair, and the copy is recorded", async () => {
	const h = await fixture([]);
	const definition = {
		...h.definition,
		request: "changed by model",
		steps: h.definition.steps.slice(0, 1),
		output: { from: ["find-source"], deliver: "show" },
	};
	let calls = 0;
	h.inference.executeStream = async (requestId) => {
		calls++;
		return {
			requestId,
			attemptId: crypto.randomUUID(),
			value: JSON.stringify({ status: "ready", definition }),
		};
	};
	const started = await h.start();
	h.run();
	await waitFor(() => h.get(started.id).status === "completed");
	expect(calls).toBe(1);
	expect(h.children).toHaveLength(1);
	const state = JSON.parse(
		(
			h.store.read((db) =>
				db
					.query("SELECT state_json FROM agent_executions WHERE id=?")
					.get(started.id),
			) as { state_json: string }
		).state_json,
	);
	expect(state.pipeline.definition.request).toBe(h.source.request);
	expect(state.pipeline.executionPlan.request).toBe(h.source.request);
	expect(state.pipeline.requestEcho).toEqual({
		matched: false,
		written: "changed by model",
		writtenLength: "changed by model".length,
	});
});

test("a reviewed collaborative draft with a changed request is still refused", async () => {
	const h = await fixture([]);
	const draft = (request: string, requestId: string) =>
		h.store.write((db) =>
			h.runtime.startPipelineInTransaction(db, {
				source: { ...h.source, specialistSessionId: "draft-session" },
				requestId,
				toolchainRevisionId: "toolchain:pipeline.execute@1",
				definition: { ...h.definition, request },
			}),
		);
	expect((await draft(h.source.request, "draft-original")).id).toBeString();
	await expect(
		Promise.resolve().then(() => draft("changed by model", "draft-changed")),
	).rejects.toThrow("pipeline_definition_invalid");
});

test("duplicate keys are a structural defect: one repair, then stop", async () => {
	const h = await fixture([]);
	const valid = JSON.stringify({ status: "ready", definition: h.definition });
	const duplicated = `{"status":"needs_input","status":"ready","definition":${JSON.stringify(h.definition)}}`;
	expect(JSON.parse(duplicated).status).toBe("ready");
	const texts = [duplicated, valid];
	let calls = 0;
	h.inference.executeStream = async (requestId, messages) => {
		h.seen.push(JSON.parse(messages.at(-1)!.content));
		return {
			requestId,
			attemptId: crypto.randomUUID(),
			value: texts[calls++]!,
		};
	};
	const repaired = await h.start();
	h.run();
	await waitFor(() => h.get(repaired.id).status === "completed");
	expect(calls).toBe(2);
	expect(String(h.seen[1]!.contractErrors)).toContain(
		"invalid_json:duplicate_key@",
	);

	const g = await fixture([]);
	let again = 0;
	g.inference.executeStream = async (requestId) => {
		again++;
		return { requestId, attemptId: crypto.randomUUID(), value: duplicated };
	};
	const stopped = await g.start();
	g.run();
	await waitFor(() => g.get(stopped.id).status === "partial");
	expect(again).toBe(2);
	expect(g.children).toHaveLength(0);
	expect(g.get(stopped.id).result?.code).toBe("pipeline_definition_invalid");
});

test("the recorded copy is bounded, an exact copy records only a match, and forgetting erases it", async () => {
	const stateOf = (h: { store: { read: Function } }, id: string) =>
		JSON.parse(
			(
				h.store.read((db: import("bun:sqlite").Database) =>
					db
						.query("SELECT state_json FROM agent_executions WHERE id=?")
						.get(id),
				) as { state_json: string }
			).state_json,
		);
	const exact = await readyFixture();
	const first = await exact.start();
	exact.run();
	await waitFor(() => exact.get(first.id).status === "completed");
	expect(stateOf(exact, first.id).pipeline.requestEcho).toEqual({
		matched: true,
	});

	const h = await fixture([]);
	const long = "言い換えた依頼".repeat(200);
	const definition = { ...h.definition, request: long };
	h.inference.executeStream = async (requestId) => ({
		requestId,
		attemptId: crypto.randomUUID(),
		value: JSON.stringify({ status: "ready", definition }),
	});
	const started = await h.start();
	h.run();
	await waitFor(() => h.get(started.id).status === "completed");
	expect(stateOf(h, started.id).pipeline.requestEcho).toEqual({
		matched: false,
		written: long.slice(0, 500),
		writtenLength: long.length,
	});
	await h.store.write((db) =>
		h.runtime.purgeSourcesInTransaction(db, {
			messageIds: [h.source.messageId],
			itemIds: [],
		}),
	);
	expect(stateOf(h, started.id)).not.toHaveProperty("pipeline");
	expect(
		JSON.stringify(
			h.store.read((db) =>
				db.query("SELECT * FROM agent_executions WHERE id=?").get(started.id),
			),
		),
	).not.toContain("言い換えた依頼");
});

test("needs_input waits without side effects; the answer keeps the original request and re-enters authoring", async () => {
	const h = await fixture([
		{ status: "needs_input", questions: ["which source?"] },
	]);
	const started = await h.start();
	h.run();
	await waitFor(() => h.get(started.id).status === "waiting_user");
	expect(h.children).toHaveLength(0);
	const definition = {
		...h.definition,
		steps: h.definition.steps.slice(0, 1),
		output: { from: ["find-source"], deliver: "show" },
	};
	h.inference.executeStream = async (requestId, messages) => {
		const input = JSON.parse(messages.at(-1)!.content);
		expect(input.request).toBe(h.source.request);
		expect(input.answers).toHaveLength(1);
		return {
			requestId,
			attemptId: crypto.randomUUID(),
			value: JSON.stringify({ status: "ready", definition }),
		};
	};
	await h.control(started.id, "answer", {
		questionRef: h.get(started.id).question!.id,
		input: "the original source",
	});
	await waitFor(() => h.get(started.id).status === "completed");
	expect(h.children).toHaveLength(1);
});

test("unsupported is explicit partial work with no child dispatch", async () => {
	const h = await fixture([
		{ status: "unsupported", reasons: ["no offered component"] },
	]);
	const started = await h.start();
	h.run();
	await waitFor(() => h.get(started.id).status === "partial");
	expect(h.children).toHaveLength(0);
	expect(h.get(started.id).result?.code).toBe("pipeline_unsupported");
});

test("revoked component revision stops the pipeline before dispatch", async () => {
	const h = await fixture([]);
	h.inference.executeStream = async (requestId) => ({
		requestId,
		attemptId: crypto.randomUUID(),
		value: JSON.stringify({ status: "ready", definition: h.definition }),
	});
	h.port.stepToolchainInTransaction = () => "toolchain:lookup@2";
	const started = await h.start();
	h.run();
	await waitFor(() => h.get(started.id).status === "partial");
	expect(h.children).toHaveLength(0);
	expect(h.get(started.id).result?.code).toBe("pipeline_component_changed");
});

test("cancelled late model output cannot launch any child", async () => {
	const h = await fixture([]);
	let resolve!: (r: Receipt) => void,
		requestId = "";
	h.inference.executeStream = async (id) => {
		requestId = id;
		return new Promise((r) => {
			resolve = r;
		});
	};
	const started = await h.start();
	h.run();
	await waitFor(() => !!resolve);
	await h.control(started.id, "cancel");
	resolve({
		requestId,
		attemptId: crypto.randomUUID(),
		value: JSON.stringify({ status: "ready", definition: h.definition }),
	});
	await new Promise((r) => setTimeout(r, 20));
	expect(h.get(started.id).status).toBe("cancelled");
	expect(h.children).toHaveLength(0);
});

const supplied = () => ({
	ref: "result:prior-chat",
	owner: "agent-runtime",
	id: "prior-chat",
	revision: "1",
	digest: "digest",
	label: "previous result",
	kind: "result" as const,
	preview: "supplied by the user",
});
async function readyFixture() {
	const h = await fixture([]);
	h.inference.executeStream = async (requestId, messages) => {
		h.seen.push(JSON.parse(messages.at(-1)!.content));
		return {
			requestId,
			attemptId: crypto.randomUUID(),
			value: JSON.stringify({ status: "ready", definition: h.definition }),
		};
	};
	return h;
}
test("from request includes supplied result references without implicitly adding later results", async () => {
	const h = await readyFixture();
	const ref = supplied();
	const started = await h.start([ref]);
	h.run();
	await waitFor(() => h.get(started.id).status === "completed");
	expect(h.seen[0]!.providedMaterials).toEqual([
		expect.objectContaining({ ref: ref.ref }),
	]);
	expect(h.children[0]!.refs).toEqual([ref]);
	expect(h.children[1]!.refs.map((r) => r.ref)).not.toContain(ref.ref);
});
test("child failure stops subsequent work and cannot become successful output", async () => {
	const h = await readyFixture();
	h.setResult({ ...done("failed"), state: "failed", code: "domain_failure" });
	const started = await h.start();
	h.run();
	await waitFor(() => h.get(started.id).status === "partial");
	expect(h.children).toHaveLength(1);
	expect(h.get(started.id).result).toMatchObject({
		code: "domain_failure",
		refs: [],
		fulfilled: [],
	});
});
test("oversized child input stops without retrying planning or dispatching", async () => {
	const h = await readyFixture();
	const refs = Array.from({ length: 20 }, (_, i) => ({
		...supplied(),
		ref: `result:${i}`,
		id: String(i),
		preview: "x".repeat(2000),
	}));
	const started = await h.start(refs);
	h.run();
	await waitFor(() => h.get(started.id).status === "partial");
	expect(h.children).toHaveLength(0);
	expect(h.get(started.id).result?.code).toBe("execution_input_capacity");
});
test("forgetting a source erases frozen requests, plans, catalog and supplied material", async () => {
	const h = await readyFixture();
	const started = await h.start([supplied()]);
	await h.store.write((db) =>
		h.runtime.purgeSourcesInTransaction(db, {
			messageIds: [h.source.messageId],
			itemIds: [],
		}),
	);
	expect(h.get(started.id).status).toBe("cancelled");
	const row = h.store.read((db) =>
		db
			.query(
				"SELECT state_json,source_json,request FROM agent_executions WHERE id=?",
			)
			.get(started.id),
	) as any;
	expect(row.source_json).toBeNull();
	expect(row.request).toBe("");
	expect(JSON.parse(row.state_json)).not.toHaveProperty("pipeline");
});
test("a persisted legacy pipeline cannot resume as the new contract", async () => {
	const h = await readyFixture();
	const started = await h.start();
	await h.store.write((db) => {
		const row = db
			.query("SELECT state_json FROM agent_executions WHERE id=?")
			.get(started.id) as any;
		const state = JSON.parse(row.state_json);
		state.pipeline = {
			toolchainRevisionId: "toolchain:legacy@1",
			inputs: { secret: "old" },
			definition: { steps: [] },
		};
		db.query("UPDATE agent_executions SET state_json=? WHERE id=?").run(
			JSON.stringify(state),
			started.id,
		);
	});
	h.run();
	await waitFor(() => h.get(started.id).status === "partial");
	expect(h.children).toHaveLength(0);
	expect(h.seen).toHaveLength(0);
});

test("typed literal arguments cross the host unchanged and expected result reaches the child", async () => {
	const h = await readyFixture();
	const records = [record("lookup"), record("operate")];
	records[0]!.card.arguments = {
		type: "object",
		properties: { text: { type: "string" } },
		required: ["text"],
		additionalProperties: false,
	};
	h.port.pipelineCatalogInTransaction = () => records;
	const literal = { text: "${inputs.unknown} is literal data" };
	h.definition.steps[0]!.arguments = literal;
	const started = await h.start();
	h.run();
	await waitFor(() => h.get(started.id).status === "completed");
	expect(h.children[0]!.arguments).toEqual(literal);
	expect(h.children[0]!.request).toContain(h.definition.steps[0]!.result);
});
test("a child's question resumes that child, then advances the frozen plan without another planning call", async () => {
	const h = await readyFixture();
	h.setResult({
		...done("which one?"),
		state: "waiting_input",
		question: "which one?",
	});
	const started = await h.start();
	h.run();
	await waitFor(() => h.get(started.id).status === "waiting_user");
	expect(h.children).toHaveLength(1);
	h.setResult(done("answered"));
	await h.control(started.id, "answer", {
		questionRef: h.get(started.id).question!.id,
		input: "this one",
	});
	await waitFor(() => h.get(started.id).status === "completed");
	expect(h.children).toHaveLength(3);
	expect(h.children[1]!.id).toBe(h.children[0]!.id);
	expect(h.children[1]!.resume?.input).toBe("this one");
	expect(h.children[2]!.chainRevisionId).toBe("toolchain:operate@1");
	expect(h.seen).toHaveLength(1);
});
test("all eight declared steps fit the existing child lifecycle", async () => {
	const h = await readyFixture();
	h.definition.steps = Array.from({ length: 8 }, (_, i) => ({
		id: `step-${i}`,
		bundle: "lookup",
		task: `task ${i}`,
		from: [i ? `step-${i - 1}` : "request"],
		result: `result ${i}`,
	}));
	h.definition.output = { from: ["step-7"], deliver: "show" };
	const started = await h.start();
	h.run();
	await waitFor(() => h.get(started.id).status === "completed");
	expect(h.children).toHaveLength(8);
	expect(h.get(started.id).result?.refs).toEqual([
		`result:${h.children[7]!.id}`,
	]);
});
