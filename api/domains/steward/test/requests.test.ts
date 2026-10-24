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
const empty = { remember: [], update: [], stop: [], notes: [], resolve: [] };
const resolve = (over: Record<string, unknown>) => ({
	request: "r1",
	action: "none",
	refs: [],
	alsoIn: [],
	text: null,
	kind: null,
	key: null,
	...over,
});
const remember = (over: Record<string, unknown> = {}) => ({
	kind: "preference",
	key: "food.spicy",
	text: "辛い食べ物が好き",
	evidence: "e1",
	quote: null,
	validFrom: null,
	validUntil: null,
	negated: false,
	...over,
});
const windowOf = (h: StewardHarness) =>
	h.store.read((db) => h.memory.windows.storedInTransaction(db, "c1"));

test("a request alone starts a unit, is settled by the request's state, and its words are cleared", async () => {
	const h = await setup();
	// The run's events are already learned; a cancelled run then leaves only a remember request.
	h.inference.script("curate-memory", empty);
	await h.run({ user: "こんにちは", end: "completed" });
	await h.drain();
	const run = await h.run({
		user: "誕生日は5月1日だと覚えて",
		end: "cancelled",
		requests: [
			{ kind: "remember", what: "誕生日は5月1日", detail: "毎年祝う" },
		],
	});
	const unit = h.units().at(-1)!;
	expect(unit).toMatchObject({
		kind: "requests",
		step: "curate-memory",
		state: "open",
	});
	h.inference.script("curate-memory", (data) => {
		const requests = data.requests as Array<Record<string, unknown>>;
		expect(requests).toEqual([
			{
				id: "r1",
				kind: "remember",
				what: "誕生日は5月1日",
				detail: "毎年祝う",
				event: "e1",
			},
		]);
		const view = (data.events as Array<Record<string, unknown>>)[0]!;
		expect(view).toMatchObject({ by: "user", reference: true });
		return {
			...empty,
			resolve: [
				resolve({
					action: "remember",
					kind: "personal_fact",
					key: "birthday",
					text: "誕生日は5月1日",
				}),
			],
		};
	});
	await h.drain();
	// Saved from the cancelled run's own message; the user confirmed it.
	const [item] = h.memory.list();
	expect(item).toMatchObject({
		text: "誕生日は5月1日",
		origin: "user_confirmed",
	});
	expect(item!.sourceMessageIds).toEqual([run.inputMessageId]);
	const [row] = h.inbox();
	expect(row).toMatchObject({ state: "done", what: "", detail: null });
	// The cancelled run recorded no event, and no more units are made.
	expect(h.log()).toHaveLength(2);
	await h.kick("c1");
	expect(h.units().filter((u) => u.state === "open")).toEqual([]);
	expect(windowOf(h)!.notices.map((n) => n.text)).toContain(
		"覚える依頼を保存しました。",
	);
});

test("several requests are settled by one call, and one the model leaves out is counted", async () => {
	const h = await setup();
	h.inference.script("curate-memory", (data) => {
		expect(data.requests).toHaveLength(3);
		return {
			...empty,
			resolve: [
				resolve({ request: "r1", action: "none" }),
				resolve({ request: "r2", action: "none" }),
			],
		};
	});
	const run = await h.run({
		user: "いろいろ",
		end: "completed",
		requests: [
			{ kind: "remember", what: "a" },
			{ kind: "remember", what: "b" },
			{ kind: "remember", what: "c" },
		],
	});
	await h.drain();
	const byId = Object.fromEntries(h.inbox().map((r) => [r.id, r]));
	expect(byId[run.requestIds[0]!]).toMatchObject({ state: "none", what: "" });
	expect(byId[run.requestIds[1]!]).toMatchObject({ state: "none", what: "" });
	// The third was not answered: tried again, and given up after three tries.
	expect(byId[run.requestIds[2]!]).toMatchObject({
		state: "none",
		resultCode: "steward_failed",
		what: "",
		failures: 3,
	});
});

test("an explicit remember of what is already stored makes a new confirmed version", async () => {
	const h = await setup();
	h.inference.script("curate-memory", { ...empty, remember: [remember()] });
	await h.run({ user: "辛いものが好きです", end: "completed" });
	await h.drain();
	const [before] = h.memory.list();
	expect(before).toMatchObject({ origin: "agent_inferred", revision: 1 });
	h.inference.script("curate-memory", (data) => {
		const longTerm = data.longTerm as Array<{ ref: string; text: string }>;
		return {
			...empty,
			resolve: [
				resolve({ action: "remember", refs: [longTerm[0]!.ref], text: null }),
			],
		};
	});
	const second = await h.run({
		user: "辛いものが好きなこと、覚えておいて",
		end: "completed",
		requests: [{ kind: "remember", what: "辛いものが好き" }],
	});
	await h.drain();
	const [after] = h.memory.list();
	expect(after).toMatchObject({ text: before!.text, origin: "user_confirmed" });
	expect(after!.id).not.toBe(before!.id);
	expect(after!.sourceMessageIds).toEqual([second.inputMessageId]);
	expect(h.memory.list(true).find((i) => i.id === before!.id)!.status).not.toBe(
		"active",
	);
	const decision = h.steward
		.decisions("c1")
		.find((d) => d.step === "curate-memory")!;
	expect(JSON.stringify(decision.results)).toContain('"reconfirmed":true');
});

test("a remember request the model answers with none but points at the stored item is still reconfirmed", async () => {
	const h = await setup();
	h.inference.script("curate-memory", { ...empty, remember: [remember()] });
	await h.run({ user: "辛いものが好きです", end: "completed" });
	await h.drain();
	const [before] = h.memory.list();
	// The live model said "already stored, nothing to save" with the item's ref and a reason as its text.
	h.inference.script("curate-memory", (data) => {
		const longTerm = data.longTerm as Array<{ ref: string }>;
		return {
			...empty,
			resolve: [
				resolve({
					action: "none",
					refs: [longTerm[0]!.ref],
					text: "既にある記憶と一致するため保存は不要です。",
				}),
			],
		};
	});
	await h.run({
		user: "辛いものが好きなこと、ちゃんと覚えておいてね",
		end: "completed",
		requests: [{ kind: "remember", what: "辛いものが好き" }],
	});
	await h.drain();
	const [after] = h.memory.list();
	expect(after).toMatchObject({ text: before!.text, origin: "user_confirmed" });
	expect(h.inbox()).toContainEqual(
		expect.objectContaining({ kind: "remember", state: "done" }),
	);
});

test("a remember request answered with none and a wrong ref is reconfirmed through its key", async () => {
	const h = await setup();
	h.inference.script("curate-memory", { ...empty, remember: [remember()] });
	await h.run({ user: "辛いものが好きです", end: "completed" });
	await h.drain();
	const [before] = h.memory.list();
	// The live model cited the event instead of the item, but named the item's key.
	h.inference.script("curate-memory", {
		...empty,
		resolve: [
			resolve({
				action: "none",
				refs: ["e1"],
				kind: "preference",
				key: before!.semanticKey,
				text: "既に保存済みです。",
			}),
		],
	});
	await h.run({
		user: "辛いものが好きなこと、覚えておいて",
		end: "completed",
		requests: [{ kind: "remember", what: "辛いものが好き" }],
	});
	await h.drain();
	const [after] = h.memory.list();
	expect(after).toMatchObject({ text: before!.text, origin: "user_confirmed" });
});

test("a request the model never answers is given up after three tries", async () => {
	const h = await setup();
	const answer = { ...empty };
	h.inference.script("curate-memory", answer, answer, answer);
	await h.run({
		user: "x",
		end: "completed",
		requests: [{ kind: "remember", what: "z" }],
	});
	await h.drain();
	const [row] = h.inbox();
	expect(row).toMatchObject({
		state: "none",
		resultCode: "steward_failed",
		what: "",
	});
});

test("a correct request updates an item and is shown to the user once as a notice", async () => {
	const h = await setup();
	h.inference.script("curate-memory", {
		...empty,
		remember: [remember({ key: "food.spicy", text: "辛いものは苦手" })],
	});
	await h.run({ user: "辛いものは苦手", end: "completed" });
	await h.drain();
	h.inference.script("curate-memory", (data) => {
		const ref = (data.longTerm as Array<{ ref: string }>)[0]!.ref;
		return {
			...empty,
			resolve: [
				resolve({
					action: "update",
					refs: [ref],
					text: "最近は辛いものも食べられる",
				}),
			],
		};
	});
	await h.run({
		user: "最近は食べられるようになった",
		end: "completed",
		requests: [{ kind: "correct", what: "辛いものが苦手 -> 食べられる" }],
	});
	await h.drain();
	expect(h.memory.list().map((i) => i.text)).toEqual([
		"最近は辛いものも食べられる",
	]);
	expect(windowOf(h)!.notices.map((n) => n.text)).toContain(
		"訂正の依頼を反映しました。",
	);
});

test("a withdraw request takes back a request that was not applied yet: the forget is not carried out", async () => {
	const h = await setup();
	h.inference.script("curate-memory", { ...empty, remember: [remember()] });
	await h.run({ user: "辛いものが好きです", end: "completed" });
	await h.drain();
	const [item] = h.memory.list();
	h.inference.script("curate-memory", (data) => {
		const requests = data.requests as Array<{ id: string; kind: string }>;
		expect(requests.map((r) => [r.id, r.kind])).toEqual([
			["r1", "forget"],
			["r2", "withdraw"],
		]);
		const ref = (data.longTerm as Array<{ ref: string }>)[0]!.ref;
		return {
			...empty,
			resolve: [
				// The model also answered the forget; a withdrawn request is not carried out whatever it wrote.
				resolve({ request: "r1", action: "forget", refs: [ref] }),
				resolve({ request: "r2", action: "withdraw", refs: ["r1"] }),
			],
		};
	});
	const run = await h.run({
		user: "辛いものを忘れて。やっぱり忘れないで",
		end: "completed",
		requests: [
			{ kind: "forget", what: "辛い食べ物" },
			{ kind: "withdraw", what: "辛いものを忘れる依頼" },
		],
	});
	await h.drain();
	expect(h.memory.list().map((i) => i.id)).toEqual([item!.id]);
	expect(h.memory.blockedMessageIds([run.inputMessageId]).size).toBe(0);
	const byId = Object.fromEntries(h.inbox().map((r) => [r.id, r]));
	expect(byId[run.requestIds[0]!]).toMatchObject({
		state: "none",
		resultCode: "withdrawn",
		what: "",
	});
	expect(byId[run.requestIds[1]!]).toMatchObject({ state: "done", what: "" });
	expect(windowOf(h)!.notices.map((n) => n.text)).toContain(
		"まだ実行していなかった記憶の依頼を取り下げました。",
	);
});

test("a withdraw request can not undo an applied forget: it finds nothing to take back and the forget stays", async () => {
	const h = await setup();
	h.inference.script("curate-memory", { ...empty, remember: [remember()] });
	await h.run({ user: "辛いものが好きです", end: "completed" });
	await h.drain();
	h.inference.script("curate-memory", (data) => {
		const ref = (data.longTerm as Array<{ ref: string }>)[0]!.ref;
		return {
			...empty,
			resolve: [resolve({ action: "forget", refs: [ref] })],
		};
	});
	await h.run({
		user: "辛いものを忘れて",
		end: "completed",
		requests: [{ kind: "forget", what: "辛い食べ物" }],
	});
	await h.drain();
	expect(
		h.memory.list(true).filter((i) => i.semanticKey === "food.spicy"),
	).toEqual([]);
	h.inference.script("curate-memory", (data) => {
		// The applied request is not offered: there is only the withdrawal to answer.
		expect((data.requests as unknown[]).length).toBe(1);
		return {
			...empty,
			resolve: [resolve({ request: "r1", action: "withdraw", refs: ["r1"] })],
		};
	});
	await h.run({
		user: "やっぱり忘れないで",
		end: "completed",
		requests: [{ kind: "withdraw", what: "辛いものを忘れる依頼" }],
	});
	await h.drain();
	expect(
		h.memory.list(true).filter((i) => i.semanticKey === "food.spicy"),
	).toEqual([]);
	expect(h.inbox().at(-1)).toMatchObject({
		kind: "withdraw",
		state: "none",
		resultCode: "nothing_to_withdraw",
	});
	expect(windowOf(h)!.notices.map((n) => n.text)).toContain(
		"取り下げられる記憶の依頼はありませんでした。すでに実行した依頼は元に戻せません。",
	);
});
