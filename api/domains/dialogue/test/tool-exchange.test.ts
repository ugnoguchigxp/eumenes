import { afterEach, expect, test } from "bun:test";
import type { ChatMessage } from "../service/context";
import { carriedToolCalls } from "../service/tool-exchange";
import {
	IMAGE,
	INSTANT,
	agencyOf,
	choice,
	setup,
	type Harness,
} from "./generation.fixture";

/**
 * What a turn keeps of its searches and hand-overs (the tool-call reliability design, P1): the calls and the host's
 * short results, kept with the agent's words for a harness that draws them as native tool messages (the cloud
 * harness). The local harness draws the words alone (the local context budget design, section 4.3); its turns are
 * routed by the host, which searches with the user's words (the local harness rebuild plan).
 */
let h: Harness | undefined;
afterEach(async () => {
	await h?.close();
	h = undefined;
});

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

/** The frozen search keeps the input version and the two candidates actually shown. */
const found = (inputId: string) => ({
	sources: h!.store.read((db) => {
		const source = h!.conversation.sourceInTransaction(db, inputId);
		if (source.state !== "available") throw new Error("missing fixture source");
		return [{ id: inputId, revision: source.revision }];
	}),
	candidates: [IMAGE, INSTANT].map((card) => ({
		id: card.id,
		revisionId: card.revisionId,
		title: card.title,
		summary: card.summary,
		execution: card.execution,
	})),
});

test("a hand-over's search and delegation are kept with the reply and marked under its words; background calls read the words only", async () => {
	h = await setup({ agency: agencyOf().agency });
	h.state.steps.push(choice({ choice: IMAGE.id }), { text: "頼みました。" });
	const asked = await h.say("猫の絵を描いて");
	h.state.steps.push(choice({ choice: "none" }), {
		text: "どういたしまして。",
	});
	await h.say("ありがとう");
	const said = "頼みました。";
	// The main conversation shows the reply and one line naming what the search found and where the work went.
	expect(recent()).toEqual([
		{
			role: "assistant",
			content: `${said}\n[道具: find_toolchain→${IMAGE.id}「${IMAGE.title}」、${INSTANT.id}「${INSTANT.title}」、delegate(${IMAGE.id})→a1]`,
		},
	]);
	expect(
		kept(said).toolCalls.map(({ name, arguments: args, result }) => ({
			name,
			args: JSON.parse(args),
			result,
		})),
	).toEqual([
		{
			// The conversation asked the existing search for candidates.
			name: "find_toolchain",
			args: { query: "猫の絵を描いて" },
			result: JSON.stringify(found(asked.inputMessageId)),
		},
		{
			name: "delegate",
			args: { toolchain: IMAGE.id, request: "猫の絵を描いて" },
			result: '{"delegated":true,"assignment":"a1"}',
		},
	]);
	// Background calls use `backgroundHarness` (words only, no tool roles that `backgroundMessage` would strip).
	const background = h.store.read((db) =>
		h!.dialogue.conversationTaskInTransaction(db, "main", "読むだけです。"),
	)!;
	expect(background.messages.some((m) => (m.role as string) === "tool")).toBe(
		false,
	);
	expect(background.messages.some((m) => m.content.includes(said))).toBe(true);
});

test("an assignment's id and a read tool's result are kept as normalized snapshots", async () => {
	h = await setup({ memory: true, agency: agencyOf().agency });
	h.state.steps.push(
		choice({ choice: "none" }),
		{ calls: [{ name: "read_memory", args: { query: "壁紙" } }] },
		{ text: "記憶にはありませんでした。" },
		choice({
			choice: IMAGE.id,
			say: "差し替えます。",
			request: "壁紙を差し替える",
		}),
		{ text: "差し替えを頼みました。" },
	);
	await h.say("壁紙のことを覚えてる？");
	const asked = await h.say("壁紙を差し替えて");
	const said = h.dialogue.answerText(asked.id)!;
	expect(said).toBe("差し替えを頼みました。");
	expect(
		kept("記憶にはありませんでした。").toolCalls.map((c) => c.name),
	).toEqual(["read_memory"]);
	const calls = kept(said).toolCalls;
	expect(calls.map((c) => c.name)).toEqual(["find_toolchain", "delegate"]);
	expect(calls.map((c) => c.result)).toEqual([
		JSON.stringify(found(asked.inputMessageId)),
		'{"delegated":true,"assignment":"a1"}',
	]);
});

test("a result keeps search candidates, the assignment, and work/memory snapshots as valid JSON", () => {
	const step = (name: string, result: unknown) => ({
		name,
		arguments: "{}",
		result,
	});
	expect(
		carriedToolCalls([
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
			step("delegate", {
				delegated: true,
				assignment: "a7",
				assignee: "画像を作る",
				next: "状態の assignments に出る",
			}),
			step("delegate", {
				delegated: false,
				code: "duplicate",
				assignment: "a7",
			}),
			step("delegate", { delegated: false, code: "agency_unavailable" }),
			step("delegate", { delegated: true }),
			step("delegate", { answered: true, answer: "東京は15時です" }),
			step("delegate", { delegated: false, code: "toolchain_unavailable" }),
			step("memory", { accepted: true, requestId: "r1" }),
		]).map((call) => [call.name, call.result]),
	).toEqual([
		["find_toolchain", '{"candidates":[{"id":"a","title":"A","summary":"s"}]}'],
		["delegate", '{"delegated":true,"assignment":"a7"}'],
		["delegate", '{"delegated":false,"assignment":"a7","code":"duplicate"}'],
		["delegate", '{"delegated":false}'],
		["delegate", '{"delegated":true}'],
		["delegate", '{"answered":true}'],
		["delegate", '{"delegated":false}'],
		["memory", '{"accepted":true,"requestId":"r1"}'],
	]);
});

test("a replayed call's arguments are always a JSON object, each text within its bound", () => {
	const args = (raw: string) =>
		carriedToolCalls([
			{ name: "delegate", arguments: raw, result: { refused: true } },
		])[0]!.arguments;
	// A call refused for its form, or one that is not an object, replays as an empty object.
	expect(args('{"toolchain":"x",')).toBe("{}");
	expect(args("")).toBe("{}");
	expect(args("[1,2]")).toBe("{}");
	const long = JSON.parse(
		args(
			JSON.stringify({
				toolchain: "fake.image",
				request: "あ".repeat(5000),
				inputs: { prompt: "い".repeat(400) },
			}),
		),
	) as { toolchain: string; request: string; inputs: { prompt: string } };
	expect(long.toolchain).toBe("fake.image");
	expect(long.request).toBe(`${"あ".repeat(300)}…`);
	expect(long.inputs.prompt).toBe(`${"い".repeat(300)}…`);
});
