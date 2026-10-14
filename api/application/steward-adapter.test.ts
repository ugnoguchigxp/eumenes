import { afterEach, expect, test } from "bun:test";
import {
	setupSteward,
	type StewardHarness,
} from "../domains/steward/test/steward.fixture";
import {
	createStewardAdapter,
	describeStewardAdapter,
	STEWARD_ADAPTER_REF,
	stewardDomainSchemas,
} from "./steward-adapter";

const harnesses: StewardHarness[] = [];
afterEach(async () => {
	for (const h of harnesses.splice(0)) await h.close();
});
async function setup() {
	const h = await setupSteward();
	harnesses.push(h);
	const adapter = createStewardAdapter(h.steward, h.memory);
	const runId = "run-tool";
	const messageId = await h.say("user", "住所を忘れて", "c1", runId);
	const origin = {
		kind: "conversation" as const,
		owner: { rootRunId: runId, taskId: "t", cancelEpoch: 0 },
		runId,
		conversationId: "c1",
		messageId,
	};
	const invoke = (input: unknown, requestId = "tool-call-1", o = origin) =>
		h.store.write((db) =>
			adapter.invokeInTransaction(db, {
				operationName: "steward.request",
				input,
				requestId,
				issuedAt: new Date(h.time.ms).toISOString(),
				origin: o,
			}),
		);
	return { h, adapter, invoke, origin, runId };
}

test("the tool stages a request and reports only that it was accepted", async () => {
	const { h, invoke } = await setup();
	const result = await invoke({ kind: "forget", what: "住所", detail: "全部" });
	expect(result.receipt).toEqual({
		requestId: "tool-call-1",
		kind: "forget",
		staged: true,
	});
	expect(result.replay).toBe(false);
	expect(JSON.stringify(result)).not.toContain("住所");
	expect(result.answerContext).toMatchObject({
		accepted: true,
		executed: false,
	});
	expect(h.inbox()).toMatchObject([
		{
			id: "tool-call-1",
			kind: "forget",
			what: "住所",
			detail: "全部",
			state: "staged",
		},
	]);
	// The steward does not read it before the run ends.
	expect(h.units()).toEqual([]);
});

test("the same tool call again is a replay and stages nothing more", async () => {
	const { h, invoke, adapter } = await setup();
	await invoke({ kind: "remember", what: "誕生日は5月1日" });
	const again = await invoke({ kind: "remember", what: "誕生日は5月1日" });
	expect(again.replay).toBe(true);
	expect(h.inbox()).toHaveLength(1);
	const read = h.store.read((db) =>
		adapter.readInTransaction(db, "tool-call-1"),
	);
	expect(read).toMatchObject({ replay: true, receipt: { kind: "remember" } });
	expect(
		h.store.read((db) => adapter.readInTransaction(db, "nope")),
	).toBeNull();
});

test("bad input, a screen origin and another conversation's message are refused with codes", async () => {
	const { invoke, origin } = await setup();
	await expect(invoke({ kind: "forget", what: "" })).rejects.toThrow(
		"invalid_input",
	);
	await expect(invoke({ kind: "delete", what: "x" })).rejects.toThrow(
		"invalid_input",
	);
	await expect(invoke({ kind: "forget", what: "x", extra: 1 })).rejects.toThrow(
		"invalid_input",
	);
	await expect(
		invoke({ kind: "forget", what: "x" }, "ui-call", {
			kind: "ui",
			scope: "s",
			actionRequestId: "a",
		} as never),
	).rejects.toThrow("unsupported_origin");
	await expect(
		invoke({ kind: "forget", what: "x" }, "other", {
			...origin,
			conversationId: "other",
		}),
	).rejects.toThrow("invalid_request_source");
});

test("the adapter is available only while memory is usable", async () => {
	const { h, adapter } = await setup();
	expect(h.store.read((db) => adapter.availableInTransaction(db))).toBe(true);
	await h.memory.setEnabled(false);
	expect(h.store.read((db) => adapter.availableInTransaction(db))).toBe(false);
});

test("what the adapter registers matches the bundle's references", () => {
	const description = describeStewardAdapter();
	expect(STEWARD_ADAPTER_REF).toBe("adapter:steward@1");
	expect(description.operations.get("steward.request")).toEqual({
		inputSchemaRef: "builtin:memoryRequest",
		effect: "write",
	});
	expect(Object.keys(stewardDomainSchemas)).toEqual([
		"domain:steward.receipt@1",
	]);
	expect(description.availability).toBe("availability:steward@1");
	expect([...description.projections]).toEqual(["projection:steward.result@1"]);
});
