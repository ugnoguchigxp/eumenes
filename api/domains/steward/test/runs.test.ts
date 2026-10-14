import { afterEach, expect, test } from "bun:test";
import { setupSteward, type StewardHarness } from "./steward.fixture";

const harnesses: StewardHarness[] = [];
afterEach(async () => {
	for (const h of harnesses.splice(0)) await h.close();
});
async function setup(runStates = {}) {
	const h = await setupSteward({ runStates });
	harnesses.push(h);
	return h;
}
const states = (h: StewardHarness) =>
	Object.fromEntries(h.inbox().map((r) => [r.id, r.state]));
const requests = [
	{ kind: "remember" as const, what: "誕生日は5月1日" },
	{ kind: "forget" as const, what: "住所" },
	{ kind: "correct" as const, what: "辛いものは平気" },
];

test("completed: the exchange and every request of the run are confirmed", async () => {
	const h = await setup();
	const run = await h.run({ user: "覚えて", end: "completed", requests });
	expect(states(h)).toEqual(
		Object.fromEntries(run.requestIds.map((id) => [id, "pending"])),
	);
	expect(h.exchangeRow(run.inputMessageId)).toMatchObject({
		outcome: "answered",
		state: "pending",
	});
	const [unit] = h.units();
	expect(unit).toMatchObject({ step: "curate-memory", kind: "exchange_step" });
});

test("failed and interrupted: the user message is an exchange without an answer and requests go on", async () => {
	const h = await setup();
	for (const end of ["failed", "interrupted"] as const) {
		const run = await h.run({ user: "予算は3万円", end, requests });
		expect(h.exchangeRow(run.inputMessageId)).toMatchObject({
			outcome: "failed",
			answerMessageId: null,
		});
		for (const id of run.requestIds) expect(states(h)[id]).toBe("pending");
	}
});

test("cancelled: no exchange; only remember goes on; forget and correct are discarded with their words cleared", async () => {
	const h = await setup();
	const run = await h.run({ user: "覚えて", end: "cancelled", requests });
	expect(h.exchangeRow(run.inputMessageId)).toBeNull();
	const [remember, forget, correct] = run.requestIds;
	expect(states(h)).toEqual({
		[remember!]: "pending",
		[forget!]: "discarded",
		[correct!]: "discarded",
	});
	const discarded = h.inbox().filter((r) => r.state === "discarded");
	expect(discarded.every((r) => r.what === "" && r.detail === null)).toBe(true);
	expect(discarded.map((r) => r.resultCode)).toEqual([
		"run_cancelled",
		"run_cancelled",
	]);
	// Only the request is left to do, so the unit is a request unit.
	expect(h.units().map((u) => u.kind)).toEqual(["requests"]);
});

test("stale: every request is discarded and nothing is registered", async () => {
	const h = await setup();
	const run = await h.run({ user: "覚えて", end: "stale", requests });
	expect(h.exchangeRow(run.inputMessageId)).toBeNull();
	expect(new Set(Object.values(states(h)))).toEqual(new Set(["discarded"]));
	expect(h.units()).toEqual([]);
});

test("requests wait as staged and the steward does not read them before the run ends", async () => {
	const h = await setup();
	const runId = "run-live";
	const messageId = await h.say("user", "覚えて", "c1", runId);
	await h.store.write((db) =>
		h.steward.stageRequestInTransaction(db, {
			requestId: "live-1",
			conversationId: "c1",
			runId,
			messageId,
			kind: "remember",
			what: "誕生日",
		}),
	);
	await h.kick("c1");
	expect(h.units()).toEqual([]);
	expect(states(h)).toEqual({ "live-1": "staged" });
});

test("staging the same tool call again is a replay; bad input and foreign sources are refused", async () => {
	const h = await setup();
	const runId = "run-s";
	const messageId = await h.say("user", "x", "c1", runId);
	const stage = (over: Record<string, unknown> = {}) =>
		h.store.write((db) =>
			h.steward.stageRequestInTransaction(db, {
				requestId: "same",
				conversationId: "c1",
				runId,
				messageId,
				kind: "remember",
				what: "w",
				...over,
			} as never),
		);
	expect(await stage()).toEqual({ id: "same", replay: false });
	expect(await stage()).toEqual({ id: "same", replay: true });
	expect(h.inbox()).toHaveLength(1);
	await expect(stage({ requestId: "b", what: "" })).rejects.toThrow();
	await expect(stage({ requestId: "c", kind: "delete" })).rejects.toThrow();
	await expect(stage({ requestId: "d", messageId: "nope" })).rejects.toThrow(
		"invalid_request_source",
	);
	await expect(
		stage({ requestId: "e", conversationId: "other" }),
	).rejects.toThrow("invalid_request_source");
});

test("at startup, the staged requests of finished runs are sorted by the same table", async () => {
	const h = await setup({
		"run-a": "completed",
		"run-b": "cancelled",
		"run-c": "active",
		"run-d": "failed",
	});
	const ids: Record<string, string> = {};
	for (const run of ["run-a", "run-b", "run-c", "run-d", "run-gone"]) {
		const messageId = await h.say("user", "x", "c1", run);
		await h.store.write((db) => {
			for (const kind of ["remember", "forget"] as const) {
				const id = `${run}:${kind}`;
				ids[id] = id;
				h.steward.stageRequestInTransaction(db, {
					requestId: id,
					conversationId: "c1",
					runId: run,
					messageId,
					kind,
					what: "w",
				});
			}
		});
	}
	await h.store.write((db) => h.steward.sweepStagedInTransaction(db));
	expect(states(h)).toEqual({
		"run-a:remember": "pending",
		"run-a:forget": "pending",
		"run-b:remember": "pending",
		"run-b:forget": "discarded",
		"run-c:remember": "staged",
		"run-c:forget": "staged",
		"run-d:remember": "pending",
		"run-d:forget": "pending",
		"run-gone:remember": "discarded",
		"run-gone:forget": "discarded",
	});
	await h.kick();
	expect(h.units().map((u) => u.kind)).toEqual(["requests"]);
});
