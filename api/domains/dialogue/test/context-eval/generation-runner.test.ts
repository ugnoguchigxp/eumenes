import { afterEach, expect, test } from "bun:test";
import { toolFields } from "../tool-text.fixture";
import type { NativeToolCall } from "../../../../infrastructure/chat-stream";
import type { InferencePort, Receipt } from "../../../inference";
import {
	rankCandidates,
	runConversation,
} from "../../eval/context/generation-runner";
import { type Materialized, materialize } from "../../eval/context/materialize";
import type { EvalCard } from "../../eval/context/session";
import { makeCase } from "./case-fixtures";
import { openSeedWiring } from "./store-wiring";

const catalog: EvalCard[] = [
	{
		id: "web_research",
		title: "Web調査",
		summary: "公開Webを調べて現在の事実を確認する",
		useWhen: ["天気や価格など今の事実の確認"],
	},
	{
		id: "image_studio",
		title: "画像制作",
		summary: "依頼から画像を作成する",
		useWhen: ["絵や画像を作る依頼"],
	},
	{
		id: "timer",
		title: "タイマー",
		summary: "相対時間のタイマーを開始する",
		useWhen: ["十分後に知らせてほしい"],
	},
];

const open: Materialized[] = [];
afterEach(async () => {
	for (const m of open.splice(0)) await m.close();
});
const prepared = async (input: string | null = "こんにちは") => {
	const m = await materialize(
		makeCase("ctx-f1-dev-01", input),
		await openSeedWiring(),
		{ catalog },
	);
	open.push(m);
	return m;
};

type Step = { text?: string; calls?: Array<[string, unknown]> };
/** A model that answers the rounds of the generation in order, and records what it was sent. */
function scripted(steps: Step[]) {
	const seen: Array<Array<{ role: string; content: string }>> = [];
	let round = 0;
	const inference: Pick<InferencePort, "answer" | "executeStream"> = {
		answer: async () => "",
		executeStream: async (requestId, messages) => {
			seen.push(messages.map((m) => ({ role: m.role, content: m.content })));
			const step = steps[Math.min(round, steps.length - 1)]!;
			round++;
			const toolCalls: NativeToolCall[] = (step.calls ?? []).map(
				([name, args], i) => ({
					id: `c${round}-${i}`,
					name,
					arguments: JSON.stringify(args),
				}),
			);
			return {
				requestId,
				attemptId: "t",
				value: step.text ?? "",
				...(toolCalls.length ? { toolCalls } : {}),
			} satisfies Receipt;
		},
	};
	return { inference, seen, rounds: () => round };
}
const run = async (m: Materialized, steps: Step[]) => {
	const model = scripted(steps);
	const outcome = await runConversation({
		inference: model.inference,
		input: m.input,
		catalog,
		signal: new AbortController().signal,
	});
	return { outcome, ...model };
};
test("a spoken answer is plain text and ends the generation in one round, with no tool call recorded", async () => {
	const { outcome, rounds } = await run(await prepared(), [
		{ text: "こんにちは。" },
	]);
	expect(outcome).toEqual({
		kind: "ok",
		text: "こんにちは。",
		toolCalls: [],
	});
	expect(rounds()).toBe(1);
});

test("a generation without an utterance may stay silent", async () => {
	const { outcome } = await run(await prepared(null), [{ text: "" }]);
	expect(outcome).toEqual({
		kind: "ok",
		text: "",
		toolCalls: [],
	});
});

test("the prepared messages lead every round, and the agent's system text is the agency's own", async () => {
	const m = await prepared("明日の天気を調べて");
	const { seen } = await run(m, [
		{ calls: [["find_toolchain", { query: "天気" }]] },
		{ text: "見つかりませんでした。" },
	]);
	expect(seen).toHaveLength(2);
	expect(seen[1]!.slice(0, m.input.messages.length)).toEqual(seen[0]!);
	// The agency's reply rules (not the retired classification) are the first part of the system message.
	expect(seen[0]![0]!.content).not.toContain("respond");
	expect(m.input.messages[0]!.content).toBe(seen[0]![0]!.content);
});

test("a search then a delegation to what it offered hands the work over: the announcement is what is heard", async () => {
	const { outcome, rounds } = await run(await prepared("明日の天気を調べて"), [
		{ calls: [["find_toolchain", { query: "天気を調べる" }]] },
		{
			calls: [
				[
					"delegate",
					{
						mode: "execute",
						toolchain: "web_research",
						request: "明日の天気を調べる",
						announcement: "お調べします。",
						impact: "none",
					},
				],
			],
		},
		{ text: "ここには来ない" },
	]);
	expect(outcome).toMatchObject({ kind: "ok", text: "お調べします。" });
	if (outcome.kind !== "ok") throw new Error("unreachable");
	expect(outcome.toolCalls.map((c) => c.name)).toEqual([
		"find_toolchain",
		"delegate",
	]);
	// The generation ended with the handover: no third round.
	expect(rounds()).toBe(2);
});

test("a delegation the host refuses is answered with its reason and the reply goes on: a toolchain nobody offered, a missing announcement, a change without confirmation", async () => {
	const delegate = (args: Record<string, unknown>): Step => ({
		calls: [
			[
				"delegate",
				{
					mode: "execute",
					toolchain: "web_research",
					request: "調べる",
					impact: "none",
					announcement: "調べます。",
					...args,
				},
			],
		],
	});
	const search: Step = { calls: [["find_toolchain", { query: "調べる" }]] };
	// Nothing was searched in the first, so the toolchain was never offered.
	const refusals: Array<[Step[], string]> = [
		[[delegate({})], "toolchain_not_offered"],
		[[search, delegate({ announcement: undefined })], "announcement_required"],
		[
			[search, delegate({ impact: "modify_existing" })],
			"confirmation_required",
		],
	];
	for (const [before, code] of refusals) {
		const m = await prepared("調べて");
		const { outcome, seen } = await run(m, [
			...before,
			{ text: "お答えします。" },
		]);
		expect(outcome).toMatchObject({ kind: "ok", text: "お答えします。" });
		const tool = seen.at(-1)!.filter((message) => message.role === "tool");
		expect(toolFields(tool.at(-1)!.content)).toMatchObject({ refused: true });
		expect(tool.at(-1)!.content).toContain(code);
		expect(
			seen
				.at(-1)!
				.some((message) =>
					message.content.includes("UNTRUSTED_REJECTED_OUTPUT"),
				),
		).toBe(false);
	}
});

test("a change is refused without its confirmation; the confirmation is issued without executing", async () => {
	const m = await prepared("設定を書き換えて");
	const search: Step = { calls: [["find_toolchain", { query: "コード" }]] };
	const call = (mode: string): Step => ({
		calls: [
			[
				"delegate",
				{
					mode,
					toolchain: "web_research",
					request: "設定を書き換える",
					announcement: "設定を書き換えてよいですか。",
					impact: "modify_existing",
				},
			],
		],
	});
	const { outcome, seen } = await run(m, [
		search,
		call("execute"),
		call("confirm"),
		{ text: "設定を書き換えてよいですか。" },
	]);
	expect(outcome).toMatchObject({
		kind: "ok",
		text: "設定を書き換えてよいですか。",
	});
	const results = seen
		.at(-1)!
		.filter((message) => message.role === "tool")
		.map((message) => toolFields(message.content));
	expect(results[1]).toMatchObject({ refused: true });
	expect(results[2]).toMatchObject({ confirmation: "eval-confirmation" });
});

test("control text in the speech is dropped from it, as in the product: the reply says nothing of it", async () => {
	const { outcome } = await run(await prepared(), [
		{ text: 'delegate({"mode":"execute"})' },
	]);
	expect(outcome).toMatchObject({ kind: "ok", text: "" });
});

test("the offline search ranks the catalog by shared character pairs, best first, at most four", () => {
	expect(rankCandidates(catalog, "画像を作る依頼")[0]!.id).toBe("image_studio");
	expect(rankCandidates(catalog, "天気を調べる")[0]!.id).toBe("web_research");
	expect(rankCandidates(catalog, "あ")).toHaveLength(3);
	const many = Array.from({ length: 7 }, (_, i) => ({
		...catalog[0]!,
		id: `t${i}`,
	}));
	expect(rankCandidates(many, "天気")).toHaveLength(4);
});
