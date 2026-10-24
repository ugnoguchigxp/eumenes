import { afterEach, expect, test } from "bun:test";
import { setupSteward, type StewardHarness } from "./steward.fixture";
import { createFakeWorld, type FakeWorld } from "./world.fake";

const harnesses: StewardHarness[] = [];
afterEach(async () => {
	for (const h of harnesses.splice(0)) await h.close();
});
async function setup() {
	let fake!: FakeWorld;
	const h = await setupSteward({
		goals: true,
		async world({ store, conversation, kick }) {
			const made = await createFakeWorld(store, conversation, kick);
			fake = made.fake;
			return made.world;
		},
	});
	harnesses.push(h);
	return { h, fake };
}
const empty = { remember: [], update: [], stop: [], notes: [], resolve: [] };
const judged = (world: boolean, goals = false) => ({
	...empty,
	route: [
		{ event: "e1", world, goals },
		{ event: "e2", world, goals },
	],
});
const claim = {
	op: "assert",
	ref: null,
	subject: "w1",
	predicate: "available",
	value: { type: "boolean", text: null, flag: true, number: null, unit: null },
	relation: null,
	evidence: "e1",
	origin: "user_report",
	validFrom: null,
	validUntil: null,
};
const answerWith = (claims: unknown[]) => ({
	entities: [],
	claims,
	changed: claims.length > 0,
});
const worldUnits = (h: StewardHarness) =>
	h.units().filter((u) => u.step === "curate-world");

async function exchangeWithEvents(
	h: StewardHarness,
	fake: FakeWorld,
	say = ["音声サービスは9月から使える", "了解しました"],
) {
	const ex = await h.run({ user: say[0]!, answer: say[1]!, end: "completed" });
	return {
		...ex,
		receive: () => fake.receiveAll([ex.inputMessageId, ex.answerMessageId!]),
	};
}

test("the events of one exchange become one world_events unit; settle, unit and decision are one result", async () => {
	const { h, fake } = await setup();
	h.inference.script("curate-memory", judged(true));
	h.inference.script("curate-world", answerWith([claim]));
	const ex = await exchangeWithEvents(h, fake);
	await h.drain();
	// The feed is later than the run: the exchange has been reflected, nothing was waiting for the World.
	expect(worldUnits(h)).toEqual([]);
	await ex.receive();
	await h.drain();

	const units = worldUnits(h);
	expect(units).toHaveLength(1);
	expect(units[0]).toMatchObject({
		kind: "world_events",
		slot: "world",
		state: "applied",
	});
	expect(JSON.parse(units[0]!.targets).events).toHaveLength(2);
	expect(fake.events().map((e) => e.state)).toEqual(["applied", "applied"]);
	// The model saw the window's utterances only, and its claim reached World in World's typed value.
	const call = h.inference.callsOf("curate-world")[0]!;
	expect((call.data.utterances as unknown[]).length).toBe(2);
	expect(JSON.stringify(fake.callsOf("settle")[0]!.detail)).toContain(
		'"value":{"type":"boolean","value":true}',
	);
	// The steward's own record: one decision, standing on the window's messages and the claim.
	const decision = h.steward
		.decisions("c1")
		.find((d) => d.step === "curate-world")!;
	expect(decision.errorCode).toBeNull();
	expect(decision.results).toMatchObject([
		{ status: "applied", claimId: "claim-1" },
	]);
	expect(
		h.store.read((db) =>
			db
				.query(
					"SELECT ref_type FROM steward_decision_ref WHERE decision_id = ? ORDER BY ref_type, ref_id",
				)
				.all(decision.id),
		),
	).toEqual([
		{ ref_type: "claim" },
		{ ref_type: "message" },
		{ ref_type: "message" },
	]);
	// A cloud-capable route, like every step of the steward.
	expect(h.inference.captures.every((c) => c.route === "conversation")).toBe(
		true,
	);
});

test("an event that arrives before curate-memory judged its exchange waits; no unit is made and no model is asked", async () => {
	const { h, fake } = await setup();
	h.inference.script("curate-memory", judged(true));
	h.inference.script("curate-world", answerWith([claim]));
	const ex = await exchangeWithEvents(h, fake);
	// Received before the steward's curate-memory ran.
	await ex.receive();
	expect(worldUnits(h)).toEqual([]);
	expect(h.inference.callsOf("curate-world")).toHaveLength(0);
	await h.drain();
	expect(worldUnits(h).map((u) => u.state)).toEqual(["applied"]);
	// The unit came after the judgment.
	const order = h.units().map((u) => u.step);
	expect(order.indexOf("curate-world")).toBeGreaterThan(
		order.indexOf("curate-memory"),
	);
});

test("an exchange judged world:false is settled empty without a model, and the decision says so", async () => {
	const { h, fake } = await setup();
	h.inference.script("curate-memory", judged(false));
	const ex = await exchangeWithEvents(h, fake, ["今日は眠い", "お大事に"]);
	await h.drain();
	await ex.receive();
	await h.drain();
	expect(worldUnits(h)).toEqual([]);
	expect(h.inference.callsOf("curate-world")).toHaveLength(0);
	expect(fake.callsOf("settleEmpty")).toHaveLength(1);
	expect(fake.events().map((e) => [e.state, e.reason])).toEqual([
		["applied", "ROUTED_EMPTY"],
		["applied", "ROUTED_EMPTY"],
	]);
	const decision = h.steward
		.decisions("c1")
		.find((d) => d.step === "curate-world")!;
	expect(decision.output).toEqual({ routed: "empty" });
});

test("a corrected version of a judged message is not routed by the old judgment", async () => {
	const { h, fake } = await setup();
	h.inference.script("curate-memory", judged(false));
	h.inference.script("curate-world", answerWith([]));
	const ex = await h.run({
		user: "最初の言い方",
		answer: "了解",
		end: "completed",
	});
	await h.drain();
	// The same message, as another version (another digest): the judgment was made of the first version.
	await fake.receive(ex.inputMessageId, { digest: "digest-of-the-correction" });
	await h.drain();
	expect(fake.callsOf("settleEmpty")).toHaveLength(0);
	expect(worldUnits(h).map((u) => u.state)).toEqual(["applied"]);
	expect(h.inference.callsOf("curate-world")).toHaveLength(1);
});

test("an exchange the steward never judged (cancelled run) and an exchange without a judgment both count as needing the world", async () => {
	const { h, fake } = await setup();
	h.inference.script("curate-world", answerWith([]), answerWith([]));
	// A cancelled run registers no exchange.
	const cancelled = await h.run({ user: "取り消した発言", end: "cancelled" });
	await fake.receive(cancelled.inputMessageId);
	await h.drain();
	expect(worldUnits(h).map((u) => u.state)).toEqual(["applied"]);
	// The model forgot the route: needed.
	h.inference.script("curate-memory", empty);
	const second = await h.run({
		user: "判定のない往復",
		answer: "了解",
		end: "completed",
	});
	await h.drain();
	await fake.receive(second.inputMessageId);
	await h.drain();
	expect(worldUnits(h).map((u) => u.state)).toEqual(["applied", "applied"]);
	expect(fake.callsOf("settleEmpty")).toHaveLength(0);
});

test("prepare that is not ready closes the unit and the timer tries again; events World finalized are done", async () => {
	const { h, fake } = await setup();
	h.inference.script("curate-memory", judged(true));
	h.inference.script("curate-world", answerWith([]));
	const ex = await exchangeWithEvents(h, fake);
	await h.drain();
	let first = true;
	fake.onPrepare = () => {
		if (!first) return undefined;
		first = false;
		return { status: "not_ready", reason: "world_unavailable", finalized: [] };
	};
	await ex.receive();
	await h.pump();
	expect(worldUnits(h).map((u) => u.state)).toEqual(["stale"]);
	expect(h.inference.callsOf("curate-world")).toHaveLength(0);
	// Nothing is enqueued for later: the wake timer carries the wait.
	expect(h.futureJobs()).toEqual([]);
	expect(h.timerTimes().length).toBeGreaterThan(0);
	await h.drain();
	expect(worldUnits(h).map((u) => u.state)).toEqual(["stale", "applied"]);
});

test("a window held three times is given up and the events after it go on", async () => {
	const { h, fake } = await setup();
	h.inference.script("curate-memory", judged(true), judged(true));
	h.inference.script(
		"curate-world",
		answerWith([]),
		answerWith([]),
		answerWith([]),
		answerWith([]),
	);
	const first = await exchangeWithEvents(h, fake);
	await h.drain();
	let holds = 0;
	fake.onSettle = (db, prepared) => {
		const ids = prepared.host.events.map((e) => e.eventId);
		if (!ids.some((id) => id.includes(first.inputMessageId))) return undefined;
		holds++;
		// World holds the window until the entities change: out of the pending list.
		for (const id of ids)
			db.query("UPDATE fake_world_event SET held = 0 WHERE event_id = ?").run(
				id,
			);
		return {
			status: "held",
			reasonCodes: ["SUBJECT_UNRESOLVED"],
			elements: [],
		};
	};
	await first.receive();
	await h.drain();
	expect(holds).toBe(3);
	expect(fake.callsOf("giveUp")).toHaveLength(1);
	expect(fake.events().map((e) => [e.state, e.reason])).toEqual([
		["rejected", "STEWARD_GAVE_UP"],
		["rejected", "STEWARD_GAVE_UP"],
	]);
	// The later exchange is not held back by it.
	const later = await exchangeWithEvents(h, fake, ["次の話", "うん"]);
	await h.drain();
	await later.receive();
	await h.drain();
	expect(
		fake
			.events()
			.slice(2)
			.map((e) => e.state),
	).toEqual(["applied", "applied"]);
});

test("a World forget since prepare voids the answer; a memory forget does too (stale, nothing applied)", async () => {
	const { h, fake } = await setup();
	h.inference.script("curate-memory", judged(true));
	h.inference.script(
		"curate-world",
		() => {
			fake.bumpEpoch();
			return answerWith([claim]);
		},
		answerWith([]),
	);
	const ex = await exchangeWithEvents(h, fake);
	await h.drain();
	await ex.receive();
	await h.drain();
	expect(worldUnits(h).map((u) => u.state)).toEqual(["stale", "applied"]);
	// The first answer never reached World's settle.
	expect(fake.callsOf("settle")).toHaveLength(1);
	const stale = h.steward
		.decisions("c1")
		.find((d) => d.errorCode === "world_forget_epoch_changed")!;
	expect(stale).toMatchObject({ step: "curate-world", output: null });
	// What the stale unit had registered was given back.
	expect(fake.callsOf("release").length).toBeGreaterThan(0);
});

test("a settle that fails half way leaves nothing: events stay pending, the unit fails, the dependents are released", async () => {
	const { h, fake } = await setup();
	h.inference.script("curate-memory", judged(true));
	h.inference.script(
		"curate-world",
		answerWith([claim]),
		answerWith([claim]),
		answerWith([claim]),
	);
	const ex = await exchangeWithEvents(h, fake);
	await h.drain();
	fake.onSettle = (db, prepared) => {
		// World wrote (the events are settled) and then something failed.
		for (const e of prepared.host.events)
			db.query(
				"UPDATE fake_world_event SET state = 'applied' WHERE event_id = ?",
			).run(e.eventId);
		throw new Error("world_write_failed");
	};
	await ex.receive();
	await h.drain();
	// Three tries, each rolled back whole; then the events are given up and the queue is free again.
	expect(worldUnits(h).map((u) => u.state)).toEqual([
		"failed",
		"failed",
		"failed",
	]);
	expect(fake.callsOf("giveUp")).toHaveLength(1);
	expect(fake.events().map((e) => e.state)).toEqual(["rejected", "rejected"]);
	const failed = h.steward
		.decisions("c1")
		.filter((d) => d.step === "curate-world");
	expect(
		failed.every((d) => d.errorCode === "apply_failed" && d.output === null),
	).toBe(true);
	expect(failed).toHaveLength(3);
});

test("an unusable answer counts against the events; after a restart the startup kick makes units for pending events", async () => {
	const { h, fake } = await setup();
	h.inference.script("curate-memory", judged(true));
	h.inference.script("curate-world", "not json", answerWith([]));
	const ex = await exchangeWithEvents(h, fake);
	await h.drain();
	await ex.receive();
	await h.drain();
	expect(worldUnits(h).map((u) => [u.state, u.attempt])).toEqual([
		["failed", 0],
		["applied", 1],
	]);
	// A conversation the steward never worked for: only the World has pending events (the notice was lost).
	const lonely = await h.say("user", "世界の話", "c9", "run-lonely");
	await h.store.write((db) => {
		db.query(
			`INSERT INTO fake_world_event (event_id, message_id, revision, digest, speaker, conversation_id, seq, state)
			 SELECT 'ev-lonely', ?, '1', 'd', 'user', 'c9', 99, 'received'`,
		).run(lonely);
	});
	h.inference.script("curate-world", answerWith([]));
	await h.kick();
	await h.drain();
	expect(
		h
			.units()
			.filter((u) => u.conversationId === "c9" && u.step === "curate-world"),
	).toHaveLength(1);
});

test("the judgment is kept per message with the version the model read, and a forget of the message removes it", async () => {
	const { h } = await setup();
	h.inference.script("curate-memory", judged(false, true));
	h.inference.script("curate-goals", { goals: [] });
	const ex = await h.run({
		user: "今日は眠い",
		answer: "お大事に",
		end: "completed",
	});
	await h.drain();
	const routes = () =>
		h.store.read((db) =>
			db
				.query(
					"SELECT message_id AS id, revision, digest, world, goals FROM steward_route ORDER BY message_id",
				)
				.all(),
		) as Array<{
			id: string;
			revision: string;
			digest: string;
			world: number;
			goals: number;
		}>;
	const found = routes();
	expect(found.map((r) => [r.id, r.world, r.goals]).sort()).toEqual(
		[
			[ex.inputMessageId, 0, 1],
			[ex.answerMessageId!, 0, 1],
		].sort(),
	);
	const state = h.store.read((db) =>
		h.conversation.sourceInTransaction(db, ex.inputMessageId),
	);
	if (state.state !== "available") throw new Error("source");
	expect(found.find((r) => r.id === ex.inputMessageId)).toMatchObject({
		revision: state.revision,
		digest: state.digest,
	});
	await h.memory.forget({
		conversationId: "c1",
		itemIds: [],
		messageIds: [ex.inputMessageId],
	});
	expect(routes()).toEqual([]);
});

const releasedIds = (fake: FakeWorld) =>
	fake.callsOf("release").flatMap((c) => c.detail as string[]);

test("a world_events unit cancelled in the queue gives back what World registered for it", async () => {
	const { h, fake } = await setup();
	h.inference.script("curate-memory", judged(true));
	const ex = await exchangeWithEvents(h, fake);
	await h.drain();
	await ex.receive();
	const [unit] = worldUnits(h);
	expect(unit).toMatchObject({ kind: "world_events", state: "open" });
	const job = h.store.read(
		(db) =>
			db
				.query(
					"SELECT id FROM queue_jobs WHERE json_extract(payload_json,'$.unitId') = ?",
				)
				.get(unit!.id) as { id: string },
	);
	await h.queue.cancel(job.id);
	expect(worldUnits(h)[0]!.state).toBe("stale");
	const events = JSON.parse(unit!.targets).events as string[];
	expect([...releasedIds(fake)].sort()).toEqual([...events].sort());
	expect(fake.events().every((e) => e.registered === 0)).toBe(true);
});

test("a retried world_events unit gives back its registration before the next try", async () => {
	const { h, fake } = await setup();
	h.inference.script("curate-memory", judged(true));
	h.inference.script(
		"curate-world",
		new Error("network_unavailable"),
		answerWith([claim]),
	);
	const ex = await exchangeWithEvents(h, fake);
	await h.drain();
	await ex.receive();
	await h.drain();
	expect(worldUnits(h).map((u) => u.state)).toEqual(["applied"]);
	expect(h.inference.callsOf("curate-world")).toHaveLength(2);
	// Two prepares, and the first one was given back at the retry.
	expect(fake.callsOf("prepare")).toHaveLength(2);
	expect(releasedIds(fake)).toHaveLength(2);
	expect(fake.events().map((e) => e.state)).toEqual(["applied", "applied"]);
});
