import { afterEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { createWorldView } from "../service/world-view";
import { keepAll, setupSteward, type StewardHarness } from "./steward.fixture";
import {
	ACCESS,
	NOW,
	PURPOSE,
	SCOPE,
	openRealWorld,
	type RealWorld,
} from "./world.real";

// The steward against the REAL World package (its store, lifecycle, curation and read API): what the fakes of the
// other tests promise, held to the real thing.

let h: StewardHarness | undefined;
afterEach(async () => {
	await h?.close();
	h = undefined;
});

async function setup(options: { worldResourceId?: string } = {}) {
	const late: {
		blocked: (db: Database, ids: Iterable<string>) => Set<string>;
		kick: (conversationId: string) => void;
	} = { blocked: () => new Set(), kick: () => {} };
	const opened = await openRealWorld({
		isAdoptedAnswer: () => true,
		blockedMessageIds: (db, ids) => late.blocked(db, ids),
		onEventsReceived: (ids) => ids.forEach((id) => late.kick(id)),
	});
	expect((await opened.registerEntity()).status).toBe("applied");
	const stewardHarness = await setupSteward({
		...options,
		goals: true,
		host: {
			store: opened.store,
			conversation: opened.conversation,
			dir: opened.dir,
			close: () => opened.cleanup(),
		},
		world: ({ kick }) => {
			late.kick = (id) => void kick(id);
			return {
				curation: opened.curation,
				view: createWorldView({
					service: opened.world,
					purpose: PURPOSE,
					scope: SCOPE,
				}),
				resumeForget: (id) => opened.lifecycle.resumeForget(id),
				scope: SCOPE,
			};
		},
	});
	h = stewardHarness;
	late.blocked = (db, ids) =>
		stewardHarness.memory.blockedMessageIdsInTransaction(db, ids);
	return { opened, h: stewardHarness };
}

const empty = { remember: [], update: [], stop: [], notes: [], resolve: [] };
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
const heads = async (opened: RealWorld) => {
	const read = await opened.world.read({
		access: ACCESS,
		scope: SCOPE,
		asOf: NOW,
	});
	if (read.status !== "ready") throw new Error(JSON.stringify(read));
	return read.snapshot.assertions;
};

test("only the World curation runs on the resource chosen for World; every other step keeps the conversation route", async () => {
	const resourceId = crypto.randomUUID();
	const { opened, h } = await setup({ worldResourceId: resourceId });
	h.inference.script("curate-memory", {
		...empty,
		route: [{ exchange: "e1", world: true, goals: false }],
	});
	h.inference.script("dispose-exchanges", keepAll);
	h.inference.script("curate-world", {
		entities: [],
		claims: [claim],
		changed: true,
	});
	await h.run({
		user: "音声サービスは9月から利用できる。",
		answer: "分かりました。",
		end: "completed",
	});
	await h.drain();
	await opened.lifecycle.consumeSourceChanges(SCOPE);
	await h.drain();
	expect(h.inference.callsOf("curate-world")).toHaveLength(1);
	const routes = h.inference.captures.map((c) => c.route);
	expect(routes.filter((r) => r !== "conversation")).toEqual([{ resourceId }]);
	expect(routes.length).toBeGreaterThan(1);
});

test("a statement reaches World through the steward, and a forget request removes the claim, its evidence and the source", async () => {
	const { opened, h } = await setup();
	h.inference.script("curate-memory", {
		...empty,
		route: [{ exchange: "e1", world: true, goals: false }],
	});
	h.inference.script("dispose-exchanges", keepAll);
	h.inference.script("curate-world", {
		entities: [],
		claims: [claim],
		changed: true,
	});
	const first = await h.run({
		user: "音声サービスは9月から利用できる。",
		answer: "分かりました。",
		end: "completed",
	});
	await h.drain();
	// World's feed receives both messages of the exchange; the notice wakes the steward.
	await opened.lifecycle.consumeSourceChanges(SCOPE);
	await h.drain();

	const units = h.units().filter((u) => u.step === "curate-world");
	expect(units.map((u) => [u.kind, u.state])).toEqual([
		["world_events", "applied"],
	]);
	const claims = await heads(opened);
	expect(claims).toHaveLength(1);
	expect(claims[0]).toMatchObject({
		lifecycle: "active",
		origin: "user_report",
	});
	// Memory knew what the model would see: the dependents were registered and are still held by the claim.
	const decision = h.steward
		.decisions("c1")
		.find((d) => d.step === "curate-world")!;
	expect(decision.errorCode).toBeNull();
	expect(decision.results).toMatchObject([
		{ kind: "claim", status: "applied", outcome: "adopted" },
	]);

	// "Forget everything about it": the model is shown World's entity and claim as refs.
	h.inference.script("curate-memory", (data) => {
		expect(data.worldEntities).toEqual([
			{ ref: "w1", name: "音声サービス", aliases: ["音声"] },
		]);
		expect(data.worldClaims).toHaveLength(1);
		return {
			...empty,
			resolve: [
				{
					request: "r1",
					action: "forget",
					refs: ["w1"],
					alsoIn: [],
					text: null,
					kind: null,
					key: null,
				},
			],
			route: [],
		};
	});
	h.inference.script("dispose-exchanges", keepAll);
	await h.run({
		user: "音声サービスのことは全部忘れて",
		end: "completed",
		requests: [{ kind: "forget", what: "音声サービス" }],
	});
	await h.drain();
	// The evidence message left the context and World's claim is forgotten once World advanced the intakes.
	expect(
		h.memory.blockedMessageIds([first.inputMessageId, first.answerMessageId!])
			.size,
	).toBe(2);
	await opened.lifecycle.resumeForgets();
	expect(await heads(opened)).toEqual([]);
	expect(
		h.steward.decisions("c1").filter((d) => d.step === "curate-world"),
	).toEqual([]);
	expect(h.inbox()).toMatchObject([{ state: "done", what: "" }]);
	// The same statement can not be curated again: its source is blocked.
	const again = opened.store.read((db) =>
		db
			.query(
				"SELECT COUNT(*) AS n FROM world_host_extract_event WHERE state = 'received'",
			)
			.get(),
	);
	expect(again).toEqual({ n: 0 });
});
