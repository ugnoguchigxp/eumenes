import { afterEach, expect, test } from "bun:test";
import { setupSteward, type StewardHarness } from "./steward.fixture";

const open: StewardHarness[] = [];
afterEach(async () => {
	for (const h of open.splice(0)) await h.close();
});
const empty = { resolve: [] };
async function setup() {
	const h = await setupSteward();
	open.push(h);
	return h;
}
async function initial(h: StewardHarness) {
	await h.seedMemory({
		user: "辛いものが好きではありません",
		key: "food.test",
		text: "辛いものが好き",
		negated: true,
	});
	expect(h.memory.list()[0]).toMatchObject({
		polarity: "negated",
		origin: "agent_inferred",
	});
}

test("explicit remember with omitted wording retains the existing negative value when reconfirmed", async () => {
	const h = await setup();
	await initial(h);
	h.inference.script("curate-memory", (data) => {
		// The request step is shown the key, the origin and the coverage of what is stored.
		expect((data.longTerm as Array<Record<string, unknown>>)[0]).toMatchObject({
			key: "food.test",
			origin: "agent_inferred",
		});
		expect(data.longTermCoverage).toMatchObject({
			stateTotal: 1,
			stateShown: 1,
		});
		return {
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
		};
	});
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
