import { afterEach, expect, test } from "bun:test";
import { type StewardHarness, setupSteward } from "./steward.fixture";

const harnesses: StewardHarness[] = [];
afterEach(async () => {
	for (const h of harnesses.splice(0)) await h.close();
});
async function setup(options: Parameters<typeof setupSteward>[0] = {}) {
	const h = await setupSteward(options);
	harnesses.push(h);
	return h;
}
const remember = {
	resolve: [
		{
			request: "r1",
			action: "remember",
			refs: [],
			alsoIn: [],
			text: "辛い食べ物が好き",
			kind: "preference",
			key: "food.spicy",
			negated: null,
		},
	],
};
const askToRemember = (h: StewardHarness, conversationId = "c1") =>
	h.run({
		user: "辛いものが好きです。覚えておいて",
		answer: "覚えておきます",
		end: "completed",
		conversationId,
		requests: [{ kind: "remember", what: "辛いものが好き" }],
	});

test("an exchange alone asks no model: nothing reflects every turn", async () => {
	const h = await setup();
	await h.run({
		user: "辛いものが好きです",
		answer: "そうなんですね",
		end: "completed",
	});
	await h.run({ user: "今日は晴れですね", answer: "はい", end: "completed" });
	await h.drain();
	expect(h.units()).toEqual([]);
	expect(h.inference.calls).toEqual([]);
	expect(h.memory.list()).toEqual([]);
});

test("the steps that answer requests share one concurrency key across conversations", async () => {
	const h = await setup();
	h.inference.script("curate-memory", remember, remember);
	await askToRemember(h, "c1");
	await askToRemember(h, "c2");
	await h.drain();
	const keys = h.store.read((db) =>
		db
			.query(
				"SELECT json_extract(payload_json,'$.unitId') AS unitId, concurrency_key AS key FROM queue_jobs",
			)
			.all(),
	) as Array<{ unitId: string; key: string }>;
	const byStep = new Map(h.units().map((u) => [u.id, u.step]));
	const pairs = keys.map((k) => [byStep.get(k.unitId), k.key]);
	const curates = pairs.filter(([s]) => s === "curate-memory");
	expect(curates).toHaveLength(2);
	expect(curates.every(([, k]) => k === "steward:long-term")).toBe(true);
});

test("a step on its own prompt runs on a connection of its own and yields to the user's calls", async () => {
	const h = await setup();
	h.inference.script("curate-memory", remember);
	await askToRemember(h);
	await h.drain();
	const [call] = h.inference.callsOf("curate-memory");
	expect(call!.session).toEqual({ sessionRole: "auxiliary", yields: true });
	expect(h.memory.list().map((item) => item.text)).toEqual([
		"辛い食べ物が好き",
	]);
});

test("on a cloud route a step reading the conversation does not read its prompt and sends its own input", async () => {
	let reads = 0;
	const h = await setup({
		conversationOnLarm: false,
		conversationTask: (_db, _conversationId, task) => {
			reads++;
			return { messages: [{ role: "user" as const, content: task }] };
		},
	});
	h.inference.script("curate-memory", remember);
	await askToRemember(h);
	await h.drain();
	const [call] = h.inference.callsOf("curate-memory");
	expect(reads).toBe(0);
	expect(call!.messages.map((m) => m.role)).toEqual(["system", "user"]);
	expect(call!.messages[1]!.content).toContain("辛いものが好きです");
	expect(call!.messages[0]!.content).toContain("OUTPUT_SCHEMA=");
	expect(call!.session).toEqual({ sessionRole: "auxiliary", yields: true });
	expect(h.memory.list().map((item) => item.text)).toEqual([
		"辛い食べ物が好き",
	]);
});

test("a step reading the conversation runs on the conversation's prompt with its own task last, on the conversation's connection", async () => {
	const prefix = {
		messages: [
			{ role: "system" as const, content: "会話の指示" },
			{ role: "user" as const, content: "<memory>\nなし\n</memory>" },
		],
	};
	const h = await setup({
		conversationTask: (_db, _conversationId, task) => ({
			messages: [
				...prefix.messages,
				{ role: "user" as const, content: `## Task\n${task}` },
			],
		}),
	});
	h.inference.script("curate-memory", remember);
	await askToRemember(h);
	await h.drain();
	const [call] = h.inference.callsOf("curate-memory");
	expect(call!.messages.slice(0, 2)).toEqual(prefix.messages);
	expect(call!.messages[2]!.content).toStartWith("## Task\n");
	expect(call!.messages[2]!.content).toContain("OUTPUT_SCHEMA=");
	expect(call!.session).toEqual({
		sessionRole: "auxiliary",
		onConversation: true,
		agentSession: { conversationId: "c1", agentId: "c1" },
	});
	// The answer is adopted as from the step's own prompt.
	expect(h.memory.list().map((item) => item.text)).toEqual([
		"辛い食べ物が好き",
	]);
});
