import { afterEach, expect, test } from "bun:test";
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
const chat = {
	kind: "chat",
	freshness: "not_live",
	impact: "none",
	approved: false,
};

test("a spoken answer with its analysis ends the generation, with the respond call recorded", async () => {
	const { outcome, rounds } = await run(await prepared(), [
		{ text: "こんにちは。", calls: [["respond", chat]] },
	]);
	expect(outcome).toEqual({
		kind: "ok",
		text: "こんにちは。",
		toolCalls: [{ name: "respond", arguments: JSON.stringify(chat) }],
		repaired: false,
	});
	expect(rounds()).toBe(1);
});

test("an answer to an utterance without its analysis is repaired once: the diagnostics go before the newest message", async () => {
	const { outcome, seen } = await run(await prepared(), [
		{ text: "こんにちは。" },
		{ text: "こんにちは。", calls: [["respond", chat]] },
	]);
	expect(outcome).toMatchObject({ kind: "ok", repaired: true });
	const second = seen[1]!;
	expect(second.at(-1)!.content).toBe("こんにちは");
	expect(second.at(-2)!.content).toContain("UNTRUSTED_REJECTED_OUTPUT");
	// The system part and the document are not touched by the repair.
	expect(second[0]).toEqual(seen[0]![0]!);
	expect(second[1]).toEqual(seen[0]![1]!);
});

test("a contract the model does not meet after the one repair is a contract failure, not a transport error", async () => {
	const { outcome } = await run(await prepared(), [{ text: "こんにちは。" }]);
	expect(outcome).toEqual({
		kind: "contract_failure",
		code: "invalid_conversation_operation",
		repaired: true,
	});
});

test("a generation without an utterance owes no analysis and may stay silent", async () => {
	const { outcome } = await run(await prepared(null), [{ text: "" }]);
	expect(outcome).toEqual({
		kind: "ok",
		text: "",
		toolCalls: [],
		repaired: false,
	});
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
		{ text: "ここには来ない", calls: [["respond", chat]] },
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

test("a delegation the host refuses is repaired: a toolchain nobody offered, a missing announcement, a change without confirmation", async () => {
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
	const refusals = [
		delegate({}),
		delegate({ announcement: undefined }),
		delegate({ impact: "modify_existing" }),
	];
	for (const refused of refusals) {
		const m = await prepared("調べて");
		const { outcome, seen } = await run(m, [
			// Nothing was searched, so the toolchain was never offered (and the others are refused on their own).
			refused,
			{ text: "お答えします。", calls: [["respond", chat]] },
		]);
		expect(outcome).toMatchObject({ kind: "ok", repaired: true });
		expect(
			seen[1]!.some((m) => m.content.includes("UNTRUSTED_REJECTED_OUTPUT")),
		).toBe(true);
	}
});

test("a confirmation is issued without executing, and a live answer needs a basis the generation settled", async () => {
	const m = await prepared("設定を書き換えて");
	const search: Step = { calls: [["find_toolchain", { query: "コード" }]] };
	const { outcome } = await run(m, [
		search,
		{
			calls: [
				[
					"delegate",
					{
						mode: "confirm",
						toolchain: "web_research",
						request: "設定を書き換える",
						announcement: "設定を書き換えてよいですか。",
						impact: "modify_existing",
					},
				],
			],
		},
		{
			text: "設定を書き換えてよいですか。",
			calls: [["respond", { ...chat, impact: "modify_existing" }]],
		},
	]);
	expect(outcome).toMatchObject({ kind: "ok", repaired: false });
	// A live answer without a delegation, an instant answer or a result in the window has no basis.
	const live = {
		kind: "live_info",
		freshness: "live",
		impact: "none",
		approved: false,
	};
	const bare = await run(await prepared("今の天気は？"), [
		{ text: "晴れです。", calls: [["respond", live]] },
		{ text: "晴れです。", calls: [["respond", live]] },
	]);
	expect(bare.outcome).toMatchObject({ kind: "contract_failure" });
	const declined = await run(await prepared("今の天気は？"), [
		{
			text: "お伝えできません。",
			calls: [["respond", { ...live, unavailable: true }]],
		},
	]);
	expect(declined.outcome).toMatchObject({ kind: "ok", repaired: false });
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
