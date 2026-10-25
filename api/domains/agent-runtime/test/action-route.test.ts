import { afterEach, expect, test } from "bun:test";
import type { ActionAdapter, ActionEnvelope } from "../../tool-runtime";
import { harness } from "./route-harness";

const open: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const close of open.splice(0)) await close();
});

const PACKAGE = "package:timers.manage@2";
const TOOL = "tool:timer.start@1";
const command = (over: Record<string, unknown> = {}) => ({
	bindingRevisionId: "binding:fake.command@1",
	adapterRef: "adapter:fake@1",
	packageRevisionId: PACKAGE,
	toolRevisionId: TOOL,
	operationName: "fake.start",
	input: { durationSeconds: 90 },
	...over,
});

/** The stored binding document the command is checked against (as a bundle would register it). */
const BINDING = {
	kind: "binding",
	id: "fake.command",
	revision: 1,
	execution: "command",
	adapterRef: "adapter:fake@1",
	availabilityRef: "availability:fake@1",
	tools: [
		{
			toolRevisionId: TOOL,
			operationId: "fake.start",
			inputSchemaRef: "builtin:timerStart",
		},
		{
			toolRevisionId: "tool:timer.list@1",
			operationId: "fake.list",
			inputSchemaRef: "builtin:timerList",
		},
	],
	outputSchemaRef: "domain:fake.receipt@1",
	resultProjectionRef: "projection:fake@1",
	artifactRevisionId: "artifact:fake.workspace@1",
};
async function withBinding(h: Awaited<ReturnType<typeof harness>>) {
	await h.store.write((db) =>
		db
			.query(
				"INSERT INTO capability_documents(id,kind,item_id,revision,digest,document_json,bundle_id,created_at_ms) VALUES(?,?,?,?,?,?,?,?)",
			)
			.run(
				"binding:fake.command@1",
				"binding",
				"fake.command",
				1,
				"digest",
				JSON.stringify(BINDING),
				"test",
				Date.now(),
			),
	);
	return h;
}

/** A domain adapter that records what the runtime asked it to run. */
function fakeAdapter(options: { fail?: string; answerContext?: unknown } = {}) {
	const seen: Array<{
		adapterRef: string;
		operationName: string;
		arguments: unknown;
		requestId: string;
		issuedAt: string;
	}> = [];
	const envelope = (adapterRef: string, id: string): ActionEnvelope => ({
		kind: "local_action",
		adapterRef,
		version: 1,
		operationId: id,
		receiptDigest: `digest-${id}`,
		payload: { ok: true },
		answerContext:
			"answerContext" in options
				? options.answerContext
				: { version: 1, kind: "fake", action: "started", items: [] },
	});
	const adapter: ActionAdapter = {
		executeInTransaction: (_tx, request) => {
			if (options.fail) throw new Error(options.fail);
			seen.push({
				adapterRef: request.adapterRef,
				operationName: request.operationName,
				arguments: request.arguments,
				requestId: request.requestId,
				issuedAt: request.issuedAt,
			});
			return envelope(request.adapterRef, `op-${request.requestId}`);
		},
		readInTransaction: (_tx, operationId, _owner, adapterRef) =>
			envelope(adapterRef, operationId),
	};
	return { adapter, seen };
}

async function startAction(
	h: Awaited<ReturnType<typeof harness>>,
	runId: string,
	over: Record<string, unknown> = {},
	capability = true,
) {
	return h.store.write((db) => {
		const cap = capability
			? h.caps.prepareBoundInTransaction(
					db,
					{ rootRunId: runId, taskId: runId, cancelEpoch: 0 },
					PACKAGE,
					TOOL,
					{ durationSeconds: 90 },
				)
			: undefined;
		return h.agents.startInTransaction(db, {
			rootRunId: runId,
			input: { kind: "action", question: "90秒", command: command(over) },
			deadline: Date.now() + 120_000,
			actionCapability: cap,
		});
	});
}
const root = (h: Awaited<ReturnType<typeof harness>>, runId: string) =>
	h.store.read((db) => h.agents.byRootInTransaction(db, runId))!;

test("an action runs the binding's adapter operation and its projection reaches the answer", async () => {
	const { adapter, seen } = fakeAdapter();
	const h = await withBinding(await harness(Date.now, adapter));
	open.push(h.close);
	await startAction(h, "run-ok");
	expect(seen).toMatchObject([
		{
			adapterRef: "adapter:fake@1",
			operationName: "fake.start",
			arguments: { durationSeconds: 90 },
		},
	]);
	expect(root(h, "run-ok").state).toBe("ready_for_answer");
	const outcome = h.store.read((db) =>
		h.agents.actionOutcomeInTransaction(db, "run-ok"),
	);
	expect(outcome).toMatchObject({
		state: "saved",
		adapterRef: "adapter:fake@1",
	});
	// The saved result reaches the answer ticket as the adapter's own projection.
	const ticket = await h.store.write((db) =>
		h.agents.prepareAnswerInTransaction(db, "run-ok"),
	);
	expect(JSON.parse(ticket.actionPayload!)).toEqual({
		version: 1,
		kind: "fake",
		action: "started",
		items: [],
	});
	expect(ticket.actionFailure).toBe(false);
	expect(
		JSON.parse(
			h.store.read(
				(db) =>
					db
						.query("SELECT input_json FROM agent_tasks WHERE id=?")
						.get(root(h, "run-ok").id) as { input_json: string },
			).input_json,
		).kind,
	).toBe("action");
});

test("a refused operation ends the task with the safe code and the answer reports a failure only", async () => {
	const { adapter } = fakeAdapter({ fail: "revision_conflict" });
	const h = await withBinding(await harness(Date.now, adapter));
	open.push(h.close);
	await startAction(h, "run-fail");
	expect(root(h, "run-fail")).toMatchObject({
		state: "ready_for_answer",
		error_code: "revision_conflict",
	});
	expect(
		h.store.read((db) => h.agents.actionOutcomeInTransaction(db, "run-fail")),
	).toEqual({ state: "failed", errorCode: "revision_conflict" });
	const ticket = await h.store.write((db) =>
		h.agents.prepareAnswerInTransaction(db, "run-fail"),
	);
	expect(ticket.actionFailure).toBe(true);
	expect(JSON.parse(ticket.actionPayload!)).toMatchObject({
		kind: "action_result",
		action: "failed",
		errorCode: "revision_conflict",
	});
});

test("a command that is malformed, for another package, or without a frozen capability is refused before the adapter", async () => {
	const { adapter, seen } = fakeAdapter();
	const h = await withBinding(await harness(Date.now, adapter));
	open.push(h.close);
	const cases: Array<[string, Record<string, unknown>, boolean, string]> = [
		["run-a", { adapterRef: "timer" }, true, "invalid_action_input"],
		["run-b", { operationName: "Bad Name" }, true, "invalid_action_input"],
		["run-c", { extra: true }, true, "invalid_action_input"],
		[
			"run-d",
			{ packageRevisionId: "package:web.search@1" },
			true,
			"capability_unavailable",
		],
		["run-e", {}, false, "required_context_missing"],
		// The binding says tool:timer.start@1 is fake.start on adapter:fake@1, nothing else.
		["run-g", { operationName: "fake.cancel" }, true, "capability_unavailable"],
		[
			"run-h",
			{ adapterRef: "adapter:other@1" },
			true,
			"capability_unavailable",
		],
		[
			"run-i",
			{ bindingRevisionId: "binding:unknown@1" },
			true,
			"capability_unavailable",
		],
		[
			"run-f",
			{ toolRevisionId: "tool:timer.list@1", operationName: "fake.list" },
			true,
			"invalid_capability_input",
		],
	];
	for (const [runId, over, capability, code] of cases) {
		await startAction(h, runId, over, capability);
		expect(root(h, runId).error_code).toBe(code);
	}
	expect(seen).toHaveLength(0);
});

test("a result that is not a bounded object is not handed to the answer", async () => {
	for (const answerContext of [
		"text",
		null,
		["list"],
		{ blob: "x".repeat(40_000) },
	]) {
		const { adapter } = fakeAdapter({ answerContext });
		const h = await withBinding(await harness(Date.now, adapter));
		open.push(h.close);
		await startAction(h, "run-ctx");
		await expect(
			h.store.write((db) => h.agents.prepareAnswerInTransaction(db, "run-ctx")),
		).rejects.toThrow("invalid_action_result");
	}
});

test("a frozen request id and decision time reach the adapter; without them the runtime mints its own", async () => {
	const { adapter, seen } = fakeAdapter();
	const h = await withBinding(await harness(Date.now, adapter));
	open.push(h.close);
	const stamp = {
		requestId: crypto.randomUUID(),
		issuedAt: new Date().toISOString(),
	};
	await startAction(h, "run-stamped", { stamp });
	await startAction(h, "run-plain");
	expect(seen[0]).toMatchObject(stamp);
	expect(seen[1]!.requestId).not.toBe(stamp.requestId);
	expect(seen[1]!.requestId).toMatch(/^[0-9a-f-]{36}$/);
	await startAction(h, "run-bad-stamp", {
		stamp: { requestId: "not-a-uuid", issuedAt: "x" },
	});
	expect(root(h, "run-bad-stamp").error_code).toBe("invalid_action_input");
});
