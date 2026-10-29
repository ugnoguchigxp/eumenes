import { afterEach, expect, test } from "bun:test";
import type { ChatMessage } from "../service/context";
import { carriedToolCalls } from "../service/tool-exchange";
import { IMAGE, INSTANT, setup, type Harness } from "./generation.fixture";

/**
 * What a turn keeps of its searches and hand-overs (the tool-call reliability design, P1): the calls and the host's
 * short results, kept with the agent's words for a harness that draws them as native tool messages. The local
 * harness draws the words alone (the local context budget design, section 4.3): these runs are served by LARM.
 */
let h: Harness | undefined;
afterEach(async () => {
	await h?.close();
	h = undefined;
});

const NO_REFS = {
	todo: () => null,
	confirmation: () => null,
	resource: () => null,
};

/** The recent conversation of the newest call: what lies between `## Memory` and the last message. */
const recent = (): ChatMessage[] =>
	h!.state.calls.at(-1)!.messages.slice(2, -1);

/** The stored utterance of the agent that said `text`. */
const kept = (text: string) =>
	h!.store
		.read((db) =>
			h!.conversation.input.utterancesAfterInTransaction(db, "main", 0),
		)
		.find((u) => u.text === text)!;

/** The fixture's search finds these two: kept by id, title, summary and execution only. */
const FOUND = {
	candidates: [IMAGE, INSTANT].map((card) => ({
		id: card.id,
		title: card.title,
		summary: card.summary,
		execution: card.execution,
	})),
};

test("a hand-over's search and delegation are kept with its announcement, the next local turn draws the words alone, and the background calls read the same prefix", async () => {
	h = await setup();
	const handOver = {
		mode: "execute",
		toolchain: IMAGE.id,
		request: "猫の絵",
		impact: "create",
		announcement: "描きますね。",
	};
	h.state.steps.push(
		{ calls: [{ name: "find_toolchain", args: { query: "猫の絵を描く" } }] },
		{ calls: [{ name: "delegate", args: handOver }] },
	);
	const waiting = await h.say("猫の絵を描いて", "queued");
	await h.finishImage(waiting.id, { state: "completed", title: "猫" });
	h.state.steps.push({ text: "どういたしまして。" });
	await h.say("ありがとう");
	// The request opened the recent conversation and is left out (it starts at the agent's).
	expect(recent()).toEqual([{ role: "assistant", content: "描きますね。" }]);
	expect(
		kept("描きますね。").toolCalls.map(({ name, arguments: args, result }) => ({
			name,
			args: JSON.parse(args),
			result,
		})),
	).toEqual([
		{
			name: "find_toolchain",
			args: { query: "猫の絵を描く" },
			result: JSON.stringify(FOUND),
		},
		{ name: "delegate", args: handOver, result: '{"todo":"t1"}' },
	]);
	const prefix = h.state.calls.at(-1)!.messages.slice(0, -1);
	const background = h.store.read((db) =>
		h!.dialogue.conversationTaskInTransaction(db, "main", "読むだけです。"),
	)!;
	expect(background.messages.slice(0, prefix.length)).toEqual(prefix);
});

test("a confirmation's number and a refused call are kept; the memory and work tools are not", async () => {
	h = await setup();
	h.state.steps.push(
		{ calls: [{ name: "memory", args: { operation: "read", query: "壁紙" } }] },
		// Not found first: the delegation is refused.
		{
			calls: [
				{
					name: "delegate",
					args: {
						mode: "confirm",
						toolchain: IMAGE.id,
						request: "壁紙を差し替える",
						impact: "modify_existing",
					},
				},
			],
		},
		{
			calls: [{ name: "find_toolchain", args: { query: "壁紙を差し替える" } }],
		},
		{
			calls: [
				{
					name: "delegate",
					args: {
						mode: "confirm",
						toolchain: IMAGE.id,
						request: "壁紙を差し替える",
						impact: "modify_existing",
					},
				},
			],
		},
		{ text: "差し替えてよいですか？" },
	);
	await h.say("壁紙を差し替えて");
	h.state.steps.push({ text: "わかりました。" });
	await h.say("やっぱりやめておく");
	const calls = kept("差し替えてよいですか？").toolCalls;
	expect(calls.map((c) => c.name)).toEqual([
		"delegate",
		"find_toolchain",
		"delegate",
	]);
	expect(calls.map((c) => c.result)).toEqual([
		'{"refused":true}',
		JSON.stringify(FOUND),
		'{"confirmation":"c1"}',
	]);
	expect(recent()).toEqual([
		{ role: "assistant", content: "差し替えてよいですか？" },
	]);
});

test("a result keeps only the candidates' names and the host's numbers, never an instant answer's text", () => {
	const refs = {
		...NO_REFS,
		todo: (id: string) => (id === "w1" ? "t4" : null),
	};
	const step = (name: string, result: unknown) => ({
		name,
		arguments: "{}",
		result,
	});
	expect(
		carriedToolCalls(
			[
				step("find_toolchain", {
					candidates: [
						{
							id: "a",
							title: "A",
							summary: "s",
							useWhen: "u",
							inputs: { x: 1 },
						},
					],
					discovery: "embedding_unavailable",
				}),
				step("delegate", { delegated: true, todo: "w1" }),
				step("delegate", { delegated: true, todo: "w9" }),
				step("delegate", { delegated: true }),
				step("delegate", { answered: true, answer: "東京は15時です" }),
				step("delegate", { delegated: false, code: "toolchain_unavailable" }),
				step("memory", { items: [] }),
				step("work", { ok: true }),
			],
			refs,
		).map((call) => [call.name, call.result]),
	).toEqual([
		["find_toolchain", '{"candidates":[{"id":"a","title":"A","summary":"s"}]}'],
		["delegate", '{"todo":"t4"}'],
		["delegate", '{"delegated":true}'],
		["delegate", '{"delegated":true}'],
		["delegate", '{"answered":true}'],
		["delegate", '{"delegated":false}'],
	]);
});

test("a replayed call's arguments are always a JSON object, each text within its bound", () => {
	const args = (raw: string) =>
		carriedToolCalls(
			[{ name: "delegate", arguments: raw, result: { refused: true } }],
			NO_REFS,
		)[0]!.arguments;
	// A call refused for its form, or one that is not an object, replays as an empty object.
	expect(args('{"mode":"execute",')).toBe("{}");
	expect(args("")).toBe("{}");
	expect(args("[1,2]")).toBe("{}");
	const long = JSON.parse(
		args(
			JSON.stringify({
				mode: "execute",
				request: "あ".repeat(5000),
				inputs: { prompt: "い".repeat(400) },
			}),
		),
	) as { mode: string; request: string; inputs: { prompt: string } };
	expect(long.mode).toBe("execute");
	expect(long.request).toBe(`${"あ".repeat(300)}…`);
	expect(long.inputs.prompt).toBe(`${"い".repeat(300)}…`);
});

test("a report keeps the notice of the work it told; the next local turn draws the words alone", async () => {
	h = await setup();
	h.state.steps.push(
		{ calls: [{ name: "find_toolchain", args: { query: "猫の絵を描く" } }] },
		{
			calls: [
				{
					name: "delegate",
					args: {
						mode: "execute",
						toolchain: IMAGE.id,
						request: "猫の絵",
						impact: "create",
						announcement: "描きますね。",
					},
				},
			],
		},
	);
	const waiting = await h.say("猫の絵を描いて", "queued");
	await h.finishImage(waiting.id, { state: "completed", title: "猫" });
	const [todo] = h.archived();
	await h.store.write((db) =>
		h!.dialogue.recordSpontaneousInTransaction(db, {
			conversationId: "main",
			messageId: "report-1",
			text: "猫の絵ができあがりました。",
			at: new Date().toISOString(),
			todoRefs: [todo!.id],
		}),
	);
	h.state.steps.push({ text: "どういたしまして。" });
	await h.say("ありがとう");
	expect(kept("猫の絵ができあがりました。").notice).toBe(
		`[ホストの知らせ] t${todo!.ref}「猫の絵」が終わりました（成功）。`,
	);
	expect(recent()).toEqual([
		{ role: "assistant", content: "描きますね。\n猫の絵ができあがりました。" },
	]);
});
