import { afterEach, expect, test } from "bun:test";
import { keepAll, setupSteward, type StewardHarness } from "./steward.fixture";

const open: StewardHarness[] = [];
afterEach(async () => {
	for (const h of open.splice(0)) await h.close();
});
const empty = { remember: [], update: [], stop: [], notes: [], resolve: [] };
async function setup() {
	const h = await setupSteward();
	open.push(h);
	return h;
}
async function initial(h: StewardHarness) {
	h.inference.script("curate-memory", {
		...empty,
		remember: [
			{
				kind: "preference",
				key: "food.test",
				text: "辛いものが好き",
				evidence: "e1",
				quote: "辛いものが好き",
				validFrom: null,
				validUntil: null,
				negated: true,
			},
		],
	});
	h.inference.script("dispose-exchanges", keepAll);
	await h.run({ user: "辛いものが好きではありません", end: "completed" });
	await h.drain();
	expect(h.memory.list()[0]).toMatchObject({
		polarity: "negated",
		origin: "agent_inferred",
	});
}

test("curation receives key, origin and coverage; update output preserves both polarities through the queue", async () => {
	const h = await setup();
	await initial(h);
	for (const negated of [true, false]) {
		h.inference.script("curate-memory", (data) => {
			const entry = (data.longTerm as Array<Record<string, unknown>>)[0]!;
			expect(entry).toMatchObject({
				key: "food.test",
				origin: "agent_inferred",
			});
			expect(data.longTermCoverage).toMatchObject({
				stateTotal: 1,
				stateShown: 1,
			});
			return {
				...empty,
				update: [
					{
						ref: entry.ref,
						text: "香辛料が好き",
						evidence: "e1",
						quote: "香辛料が好き",
						negated,
					},
				],
			};
		});
		h.inference.script("dispose-exchanges", keepAll);
		await h.run({
			user: negated ? "今も香辛料が好きではない" : "今は香辛料が好き",
			end: "completed",
		});
		await h.drain();
		expect(h.memory.list()[0]).toMatchObject({
			text: "香辛料が好き",
			polarity: negated ? "negated" : "affirmed",
		});
	}
});

test("explicit remember with omitted wording retains the existing negative value when reconfirmed", async () => {
	const h = await setup();
	await initial(h);
	h.inference.script("curate-memory", (data) => ({
		...empty,
		resolve: [
			{
				request: "r1",
				action: "remember",
				refs: [(data.longTerm as Array<{ ref: string }>)[0]!.ref],
				alsoIn: [],
				text: null,
				kind: null,
				key: null,
				negated: null,
			},
		],
	}));
	h.inference.script("dispose-exchanges", keepAll);
	await h.run({
		user: "辛いものが好きではないことを覚えて",
		end: "completed",
		requests: [{ kind: "remember", what: "辛いものが好きではない" }],
	});
	await h.drain();
	expect(h.memory.list()[0]).toMatchObject({
		text: "辛いものが好き",
		polarity: "negated",
		origin: "user_confirmed",
	});
	expect(h.inbox()).toContainEqual(
		expect.objectContaining({ kind: "remember", state: "done" }),
	);
});

test("explicit correction carries the model's negated output to State", async () => {
	const h = await setup();
	await initial(h);
	h.inference.script("curate-memory", (data) => ({
		...empty,
		resolve: [
			{
				request: "r1",
				action: "update",
				refs: [(data.longTerm as Array<{ ref: string }>)[0]!.ref],
				alsoIn: [],
				text: "唐辛子が好き",
				kind: null,
				key: null,
				negated: true,
			},
		],
	}));
	h.inference.script("dispose-exchanges", keepAll);
	await h.run({
		user: "唐辛子が好きではないに訂正して",
		end: "completed",
		requests: [{ kind: "correct", what: "唐辛子が好きではない" }],
	});
	await h.drain();
	expect(h.memory.list()[0]).toMatchObject({
		text: "唐辛子が好き",
		polarity: "negated",
		origin: "user_confirmed",
	});
});
