import { afterEach, expect, test } from "bun:test";
import type { TargetRequest } from "../contracts";
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

/** A request that names its target in words, made in a run of the conversation. */
async function target(
	h: StewardHarness,
	kind: TargetRequest["kind"],
	over: Partial<TargetRequest> = {},
) {
	const messageId = await h.say("user", "あの話は忘れて", "c1", "run-t");
	const request: TargetRequest = {
		conversationId: "c1",
		runId: "run-t",
		kind,
		what: "元カノの話",
		messageIds: [messageId],
		requestId: `${kind}-1`,
		...over,
	};
	return { request, messageId };
}

test("a correction or a suppression that names its target in words waits in the inbox for the agency, and no model step is made for it", async () => {
	const h = await setup();
	const correct = await target(h, "correct", {
		what: "歯医者は木曜",
		requestId: "t-correct",
	});
	const suppress = await target(h, "suppress", {
		what: "仕事の話",
		requestId: "t-suppress",
	});
	await h.store.write((db) => {
		h.steward.targetRequestInTransaction(db, {
			id: "t-correct",
			request: correct.request,
		});
		h.steward.targetRequestInTransaction(db, {
			id: "t-suppress",
			request: suppress.request,
		});
		// Asking again with the same id is the same request.
		h.steward.targetRequestInTransaction(db, {
			id: "t-correct",
			request: correct.request,
		});
	});
	await h.runEnded("run-t", "c1", "completed");
	await h.kick();
	await h.drain();
	expect(h.units()).toEqual([]);
	expect(h.inference.calls).toEqual([]);
	expect(h.inbox().map((r) => [r.id, r.kind, r.state])).toEqual([
		["t-correct", "correct", "pending"],
		["t-suppress", "suppress", "pending"],
	]);
	const pending = h.store.read((db) =>
		h.steward.pendingTargetsInTransaction(db, { conversationId: "c1" }),
	);
	expect(pending.map((p) => [p.id, p.request.kind])).toEqual([
		["t-correct", "correct"],
		["t-suppress", "suppress"],
	]);
	expect(
		h.store.read((db) => h.steward.pendingTargetsInTransaction(db, {})),
	).toHaveLength(2);
	expect(
		h.store.read((db) =>
			h.steward.pendingTargetsInTransaction(db, { conversationId: "other" }),
		),
	).toEqual([]);
	// Neither is a forget.
	expect(
		h.store.read((db) => h.steward.hasPendingForgetInTransaction(db, "c1")),
	).toBe(false);
	// A source that is not the user's message of the conversation is refused.
	await expect(
		h.store.write((db) =>
			h.steward.targetRequestInTransaction(db, {
				id: "bad",
				request: { ...correct.request, messageIds: ["nope"] },
			}),
		),
	).rejects.toThrow("invalid_request_source");
});

test("a forget the conversation agent queued keeps its row and gets the details; it is a pending forget until its targets are excluded", async () => {
	const h = await setup();
	const forget = await target(h, "forget", { requestId: "f-1" });
	await h.store.write((db) => {
		h.steward.requestInTransaction(db, {
			requestId: "f-1",
			conversationId: "c1",
			sourceRef: forget.messageId,
			kind: "forget",
			what: "元カノの話",
		});
		h.steward.targetRequestInTransaction(db, {
			id: "f-1",
			request: forget.request,
		});
	});
	await h.runEnded("run-t", "c1", "completed");
	await h.drain();
	// One row, and no `curate-memory` unit: only the agency resolves a forget without a reference.
	expect(h.inbox()).toHaveLength(1);
	expect(h.units()).toEqual([]);
	expect(
		h.store.read((db) => h.steward.hasPendingForgetInTransaction(db, "c1")),
	).toBe(true);
	expect(
		h.store.read((db) => h.steward.pendingTargetsInTransaction(db, {}))[0],
	).toMatchObject({ id: "f-1", request: { kind: "forget" } });
	// The agency excluded the targets: no longer a pending forget, nor a target to resolve; the closure follows.
	const marked = await h.store.write((db) =>
		h.steward.excludedInTransaction(db, {
			id: "f-1",
			conversationId: "c1",
			exclusion: {
				itemIds: [],
				messageIds: [],
				claimIds: [],
				entityIds: [],
				goalIds: [],
			},
		}),
	);
	expect(marked).toBe(true);
	expect(
		h.store.read((db) => h.steward.hasPendingForgetInTransaction(db, "c1")),
	).toBe(false);
	expect(
		h.store.read((db) => h.steward.pendingTargetsInTransaction(db, {})),
	).toEqual([]);
	await h.drain();
	expect(h.inbox()).toMatchObject([{ id: "f-1", state: "done", what: "" }]);
});

test("a request the agency could not settle ends without a change and is told to the user once", async () => {
	const h = await setup();
	const correct = await target(h, "correct", { requestId: "t-un" });
	await h.store.write((db) =>
		h.steward.targetRequestInTransaction(db, {
			id: "t-un",
			request: correct.request,
		}),
	);
	expect(
		await h.store.write((db) =>
			h.steward.settleTargetInTransaction(db, {
				id: "t-un",
				outcome: "unresolved",
			}),
		),
	).toBe(true);
	// Settling twice is no more than the first.
	expect(
		await h.store.write((db) =>
			h.steward.settleTargetInTransaction(db, {
				id: "t-un",
				outcome: "applied",
			}),
		),
	).toBe(false);
	expect(h.inbox()).toMatchObject([
		{ state: "none", resultCode: "unresolved", what: "元カノの話" },
	]);
	expect(
		h.store.read((db) => h.steward.pendingTargetsInTransaction(db, {})),
	).toEqual([]);
	const told = await h.store.write((db) =>
		h.steward.takeUnresolvedTargetsInTransaction(db, "c1"),
	);
	expect(told).toEqual([{ id: "t-un", kind: "correct", what: "元カノの話" }]);
	// Each once; the words are gone after.
	expect(
		await h.store.write((db) =>
			h.steward.takeUnresolvedTargetsInTransaction(db, "c1"),
		),
	).toEqual([]);
	expect(h.inbox()).toMatchObject([{ state: "none", what: "" }]);
});

test("an applied request ends done with its words cleared, and a forgotten source clears a request that waits", async () => {
	const h = await setup();
	const a = await target(h, "suppress", { requestId: "t-a" });
	const b = await target(h, "correct", { requestId: "t-b" });
	await h.store.write((db) => {
		h.steward.targetRequestInTransaction(db, { id: "t-a", request: a.request });
		h.steward.targetRequestInTransaction(db, { id: "t-b", request: b.request });
		h.steward.settleTargetInTransaction(db, { id: "t-a", outcome: "applied" });
	});
	expect(h.inbox().find((r) => r.id === "t-a")).toMatchObject({
		state: "done",
		what: "",
	});
	// The user forgets the message the other request was made in: its words and details go with it.
	await h.memory.forget({
		conversationId: "c1",
		itemIds: [],
		messageIds: [b.messageId],
	});
	expect(h.inbox().find((r) => r.id === "t-b")).toMatchObject({
		state: "none",
		what: "",
	});
	expect(
		h.store.read((db) => h.steward.pendingTargetsInTransaction(db, {})),
	).toEqual([]);
});
