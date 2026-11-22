import { afterEach, expect, test } from "bun:test";
import { closeSleepHarnesses, setupSleep as setup } from "./sleep.fixture";

afterEach(closeSleepHarnesses);

test("the forget closure runs at once, even while a run is going, and ends the excluded request", async () => {
	const h = await setup();
	const seeded = await h.seedMemory({
		user: "住所は東京都です",
		text: "住所は東京都",
		key: "address",
		kind: "personal_fact",
	});
	const messageId = await h.say("user", "住所を忘れて", "c1", "run-live");
	await h.store.write((db) =>
		h.steward.requestInTransaction(db, {
			requestId: "forget-1",
			conversationId: "c1",
			sourceRef: messageId,
			kind: "forget",
			what: "住所",
		}),
	);
	h.foreground.add("c1");
	await h.store.write((db) =>
		h.steward.excludedInTransaction(db, {
			id: "forget-1",
			conversationId: "c1",
			exclusion: {
				itemIds: [seeded.itemId],
				messageIds: [seeded.inputMessageId],
				claimIds: [],
				entityIds: [],
				goalIds: [],
			},
		}),
	);
	// The request waits, across a restart, as an excluded forget and is no longer an ordinary pending one.
	expect(h.inbox()).toMatchObject([{ id: "forget-1", state: "excluded" }]);
	await h.drain();
	expect(h.memory.list(true)).toEqual([]);
	expect(h.memory.blockedMessageIds([seeded.inputMessageId]).size).toBe(1);
	expect(h.inbox()).toMatchObject([
		{ id: "forget-1", state: "done", what: "" },
	]);
	expect(h.units().map((u) => [u.step, u.state, u.slot])).toEqual([
		["forget-closure", "applied", "maintenance"],
	]);
	expect(h.notices()).toContain("忘れる依頼を実行しました。");
	// A restart finds nothing left to close.
	await h.kick();
	expect(h.units()).toHaveLength(1);
});

test("an excluded forget not yet closed is made again by the startup kick", async () => {
	const h = await setup();
	const seeded = await h.seedMemory({
		user: "住所は東京都です",
		text: "住所は東京都",
		key: "address",
	});
	const messageId = await h.say("user", "住所を忘れて", "c1", "run-x");
	await h.store.write((db) => {
		h.steward.requestInTransaction(db, {
			requestId: "forget-2",
			conversationId: "c1",
			sourceRef: messageId,
			kind: "forget",
			what: "住所",
		});
		db.query(
			"UPDATE steward_inbox SET state = 'excluded', exclusion = ? WHERE id = 'forget-2'",
		).run(
			JSON.stringify({
				itemIds: [seeded.itemId],
				messageIds: [],
				claimIds: [],
				entityIds: [],
				goalIds: [],
			}),
		);
	});
	expect(h.units()).toEqual([]);
	await h.kick();
	await h.drain();
	expect(h.memory.list(true)).toEqual([]);
	expect(h.inbox()).toMatchObject([{ state: "done" }]);
});

test("the closure delete has no limit on the count: a fact of six versions goes whole", async () => {
	const h = await setup();
	const exchange = await h.run({
		user: "住所の話",
		answer: "はい",
		end: "completed",
	});
	let current = await h.seedMemory({
		user: "住所は大阪市です",
		text: "住所は大阪市",
		key: "address",
		kind: "personal_fact",
	});
	for (const city of ["京都市", "神戸市", "奈良市", "福岡市", "東京都"]) {
		const said = await h.run({ user: `住所は${city}です`, end: "completed" });
		const item = h.memory.list().find((i) => i.semanticKey === "address")!;
		await h.store.write((db) =>
			h.memory.applyCurationInTransaction(db, {
				conversationId: "c1",
				items: [
					{
						op: "update",
						itemId: item.id,
						revision: item.revision,
						text: `住所は${city}`,
						messageId: said.inputMessageId,
						quote: null,
					},
				],
			}),
		);
		current = { ...current, itemId: item.id };
	}
	const all = h.memory.list(true).map((i) => i.id);
	expect(all).toHaveLength(6);
	const messageId = await h.say("user", "住所を忘れて", "c1", "run-f");
	await h.store.write((db) => {
		h.steward.requestInTransaction(db, {
			requestId: "forget-six",
			conversationId: "c1",
			sourceRef: messageId,
			kind: "forget",
			what: "住所",
		});
		h.steward.excludedInTransaction(db, {
			id: "forget-six",
			conversationId: "c1",
			exclusion: {
				itemIds: all,
				messageIds: [],
				claimIds: [],
				entityIds: [],
				goalIds: [],
			},
		});
	});
	await h.drain();
	// Six versions are more than the request's own limit of five: the closure has none.
	expect(h.memory.list(true)).toEqual([]);
	expect(h.inbox().find((r) => r.id === "forget-six")).toMatchObject({
		state: "done",
	});
	expect(exchange.inputMessageId).toBeDefined();
});

test("the closure job takes no inference slot", async () => {
	const h = await setup();
	const seeded = await h.seedMemory({
		user: "住所は東京都です",
		text: "住所は東京都",
		key: "address",
	});
	const messageId = await h.say("user", "住所を忘れて", "c1", "run-r");
	await h.store.write((db) => {
		h.steward.requestInTransaction(db, {
			requestId: "forget-r",
			conversationId: "c1",
			sourceRef: messageId,
			kind: "forget",
			what: "住所",
		});
		h.steward.excludedInTransaction(db, {
			id: "forget-r",
			conversationId: "c1",
			exclusion: {
				itemIds: [seeded.itemId],
				messageIds: [],
				claimIds: [],
				entityIds: [],
				goalIds: [],
			},
		});
	});
	const jobs = h.store.read(
		(db) =>
			db
				.query(
					"SELECT resource_key AS resource, concurrency_key AS key FROM queue_jobs",
				)
				.all() as Array<{ resource: string; key: string }>,
	);
	expect(jobs).toEqual([{ resource: "steward.forget", key: "steward:forget" }]);
	await h.drain();
	expect(h.memory.list(true)).toEqual([]);
});

test("after a restored database the startup kick closes what the library holds excluded and no request names", async () => {
	const h = await setup();
	const seeded = await h.seedMemory({
		user: "住所は東京都です",
		text: "住所は東京都",
		key: "address",
		kind: "personal_fact",
	});
	// The journal put the exclusion back; the inbox row of the backup knows nothing of it.
	const excluded = await h.store.write((db) =>
		h.memory.excludeForForgetInTransaction(db, {
			conversationId: "c1",
			sourceRunId: "run-lost",
			targets: [{ itemId: seeded.itemId }],
		}),
	);
	expect(excluded.status).toBe("applied");
	expect(h.inbox()).toEqual([]);
	await h.kick();
	await h.drain();
	expect(h.memory.list(true)).toEqual([]);
	expect(h.units().map((u) => [u.step, u.state])).toEqual([
		["forget-closure", "applied"],
	]);
	// A request that names its items is not an orphan: its own closure is the one that ran.
	await h.kick();
	expect(h.units()).toHaveLength(1);
});
