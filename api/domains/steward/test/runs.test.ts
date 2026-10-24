import { afterEach, expect, test } from "bun:test";
import { setupSteward, type StewardHarness } from "./steward.fixture";

const harnesses: StewardHarness[] = [];
afterEach(async () => {
	for (const h of harnesses.splice(0)) await h.close();
});
async function setup() {
	const h = await setupSteward();
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

test("completed: the run's events are in the log and every request is pending", async () => {
	const h = await setup();
	const run = await h.run({ user: "覚えて", end: "completed", requests });
	expect(states(h)).toEqual(
		Object.fromEntries(run.requestIds.map((id) => [id, "pending"])),
	);
	expect(h.log().map((e) => [e.by, e.messageIds, e.curated])).toEqual([
		["user", [run.inputMessageId], false],
		["agent", [run.answerMessageId!], false],
	]);
	const [unit] = h.units();
	expect(unit).toMatchObject({ step: "curate-memory", kind: "events" });
});

test("failed and interrupted: only the user's event is in the log and requests go on", async () => {
	const h = await setup();
	for (const end of ["failed", "interrupted"] as const) {
		const run = await h.run({ user: "予算は3万円", end, requests });
		expect(
			h.log().filter((e) => e.messageIds.includes(run.inputMessageId)),
		).toHaveLength(1);
		for (const id of run.requestIds) expect(states(h)[id]).toBe("pending");
	}
});

test("cancelled: no event, and every request goes on (a stopped generation does not take back what it asked)", async () => {
	const h = await setup();
	const run = await h.run({ user: "覚えて", end: "cancelled", requests });
	expect(h.log()).toEqual([]);
	expect(states(h)).toEqual(
		Object.fromEntries(run.requestIds.map((id) => [id, "pending"])),
	);
	expect(h.inbox().every((r) => r.what !== "")).toBe(true);
	// Only the requests are left to do, so the unit is a request unit.
	expect(h.units().map((u) => u.kind)).toEqual(["requests"]);
});

test("stale: the requests that were committed stay too, and nothing else is registered", async () => {
	const h = await setup();
	const run = await h.run({ user: "覚えて", end: "stale", requests });
	expect(h.log()).toEqual([]);
	expect(new Set(Object.values(states(h)))).toEqual(new Set(["pending"]));
	expect(h.inbox()).toHaveLength(run.requestIds.length);
});

test("a request is pending at once, and the steward does not read it before the run ends", async () => {
	const h = await setup();
	const messageId = await h.say("user", "覚えて", "c1", "run-live");
	await h.store.write((db) =>
		h.steward.requestInTransaction(db, {
			requestId: "live-1",
			conversationId: "c1",
			sourceRef: messageId,
			kind: "remember",
			what: "誕生日",
		}),
	);
	await h.kick("c1");
	expect(states(h)).toEqual({ "live-1": "pending" });
	// The kick the dialogue gives at the run's end is what starts the unit.
	await h.runEnded("run-live", "c1", "completed");
	expect(h.units().map((u) => u.kind)).toEqual(["requests"]);
});

test("asking the same tool call again is a replay; bad input and foreign sources are refused", async () => {
	const h = await setup();
	const messageId = await h.say("user", "x", "c1", "run-s");
	const ask = (over: Record<string, unknown> = {}) =>
		h.store.write((db) =>
			h.steward.requestInTransaction(db, {
				requestId: "same",
				conversationId: "c1",
				sourceRef: messageId,
				kind: "remember",
				what: "w",
				...over,
			} as never),
		);
	expect(await ask()).toEqual({ id: "same", replay: false });
	expect(await ask()).toEqual({ id: "same", replay: true });
	expect(h.inbox()).toHaveLength(1);
	// Without an id the request still gets one.
	const anonymous = await ask({ requestId: undefined });
	expect(anonymous.replay).toBe(false);
	expect(anonymous.id).not.toBe("same");
	await expect(ask({ requestId: "b", what: "" })).rejects.toThrow();
	await expect(ask({ requestId: "c", kind: "delete" })).rejects.toThrow();
	await expect(ask({ requestId: "d", sourceRef: "nope" })).rejects.toThrow(
		"invalid_request_source",
	);
	await expect(
		ask({ requestId: "e", conversationId: "other" }),
	).rejects.toThrow("invalid_request_source");
	await expect(
		ask({ requestId: "same", conversationId: "other" }),
	).rejects.toThrow("request_conflict");
});

test("a request the steward has not applied survives a restart: the startup kick makes its unit", async () => {
	const h = await setup();
	const messageId = await h.say("user", "x", "c1", "run-a");
	await h.store.write((db) =>
		h.steward.requestInTransaction(db, {
			conversationId: "c1",
			sourceRef: messageId,
			kind: "forget",
			what: "住所",
		}),
	);
	expect(h.units()).toEqual([]);
	await h.kick();
	expect(h.units().map((u) => u.kind)).toEqual(["requests"]);
});
