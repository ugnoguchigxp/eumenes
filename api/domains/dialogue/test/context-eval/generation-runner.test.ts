import { afterEach, expect, test } from "bun:test";
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
const prepared = async (
	input: string | null = "こんにちは",
	over: Parameters<typeof makeCase>[2] = {},
) => {
	const m = await materialize(
		makeCase("ctx-f1-dev-01", input, over),
		await openSeedWiring(),
		{ catalog },
	);
	open.push(m);
	return m;
};

/** One call of the scripted model: a choice (JSON held to the schema it was sent) or the talk turn's words. */
type Seen = {
	messages: Array<{ role: string; content: string }>;
	schema: Record<string, unknown> | undefined;
};
/** A model that answers the choice calls from `choices` and the talk calls from `talk`, and records what it was sent. */
function scripted(script: { choices?: unknown[]; talk?: string }) {
	const seen: Seen[] = [];
	let choice = 0;
	const inference: Pick<InferencePort, "answer" | "executeStream"> = {
		answer: async () => "",
		executeStream: async (
			requestId,
			messages,
			_signal,
			_onDelta,
			_preparation,
			_tools,
			session,
		) => {
			seen.push({
				messages: messages.map((m) => ({ role: m.role, content: m.content })),
				schema: session?.outputSchema,
			});
			const value = session?.outputSchema
				? JSON.stringify(
						script.choices?.[
							Math.min(choice++, (script.choices?.length ?? 1) - 1)
						] ?? { choice: "none" },
					)
				: (script.talk ?? "");
			return { requestId, attemptId: "t", value } satisfies Receipt;
		},
	};
	return { inference, seen };
}
const run = async (m: Materialized, script: Parameters<typeof scripted>[0]) => {
	const model = scripted(script);
	const outcome = await runConversation({
		inference: model.inference,
		input: m.input,
		catalog,
		persona: m.persona,
		signal: new AbortController().signal,
	});
	return { outcome, ...model };
};
const names = (outcome: Awaited<ReturnType<typeof run>>["outcome"]) =>
	outcome.kind === "ok" ? outcome.toolCalls.map((c) => c.name) : [];

test("no request: the host searches with the user's words, the choice is none and the talk turn answers in plain words", async () => {
	const { outcome, seen } = await run(await prepared(), {
		choices: [{ choice: "none" }],
		talk: "こんにちは。",
	});
	expect(outcome).toMatchObject({ kind: "ok", text: "こんにちは。" });
	expect(names(outcome)).toEqual(["find_toolchain"]);
	// One silent choice held to a schema, then one talk call without one.
	expect(seen.map((call) => call.schema !== undefined)).toEqual([true, false]);
});

test("a generation without an utterance only talks, and may stay silent", async () => {
	const { outcome, seen } = await run(await prepared(null), { talk: "" });
	expect(outcome).toEqual({ kind: "ok", text: "", toolCalls: [] });
	expect(seen).toHaveLength(1);
	expect(seen[0]!.schema).toBeUndefined();
});

test("the choice reads the host's search: the candidates and the user's words, and its schema offers exactly them", async () => {
	const { seen } = await run(await prepared("明日の天気を調べて"), {
		choices: [{ choice: "none" }],
		talk: "見つかりませんでした。",
	});
	const choice = seen[0]!;
	const text = choice.messages.map((m) => m.content).join("\n");
	expect(text).toContain("明日の天気を調べて");
	expect(text).toContain("web_research");
	const offered = (
		choice.schema!.anyOf as Array<{
			properties: { choice: { enum: string[] } };
		}>
	).flatMap((branch) => branch.properties.choice.enum);
	expect(offered).toContain("web_research");
	expect(offered).toContain("none");
});

test("a choice of what the search offered hands the work over: the announcement is what is heard, and no talk call follows", async () => {
	const { outcome, seen } = await run(await prepared("明日の天気を調べて"), {
		choices: [
			{
				choice: "web_research",
				say: "お調べします。",
				request: "明日の天気を調べる",
			},
		],
		talk: "ここには来ない",
	});
	expect(outcome).toMatchObject({ kind: "ok", text: "お調べします。" });
	expect(names(outcome)).toEqual(["find_toolchain", "delegate"]);
	expect(seen).toHaveLength(1);
});

test("a choice the host refuses is made again once with its reason: a toolchain nobody offered, an announcement with no words", async () => {
	const refusals: Array<[unknown, string]> = [
		[
			{ choice: "image_studio_x", say: "描きます。", request: "描く" },
			"choice_not_offered",
		],
		[
			{ choice: "web_research", say: "", request: "調べる" },
			"invalid_tool_arguments",
		],
	];
	for (const [first, code] of refusals) {
		const { outcome, seen } = await run(await prepared("調べて"), {
			choices: [first, { choice: "none" }],
			talk: "お答えします。",
		});
		expect(outcome).toMatchObject({ kind: "ok", text: "お答えします。" });
		// The second choice read why the first could not be carried out.
		const second = seen.filter((call) => call.schema)[1]!;
		expect(second.messages.map((m) => m.content).join("\n")).toContain(code);
	}
});

test("a request that names a saved item is confirmed first: the confirmation is issued without executing, and the host says it", async () => {
	const { outcome } = await run(await prepared("設定を書き換えて"), {
		choices: [
			{
				choice: "web_research",
				say: "書き換えます。",
				request: "設定を書き換える",
				target: "saved-item",
			},
		],
	});
	expect(names(outcome)).toEqual(["find_toolchain", "delegate", "delegate"]);
	if (outcome.kind !== "ok") throw new Error("unreachable");
	const modes = outcome.toolCalls
		.filter((c) => c.name === "delegate")
		.map((c) => JSON.parse(c.arguments!).mode);
	expect(modes).toEqual(["execute", "confirm"]);
	expect(outcome.text).toContain("Web調査");
});

test("an open confirmation is answered by the pending turn: approving hands the work over, declining closes it", async () => {
	const over = {
		seed: {
			confirmations: [
				{
					toolchain: "web_research",
					request: "調べる",
					impact: "modify_existing",
				},
			],
		},
	} as never;
	const approved = await run(await prepared("はい、お願いします", over), {
		choices: [{ choice: "approve", confirmation: "c1" }],
	});
	expect(names(approved.outcome)).toEqual(["delegate"]);
	expect(approved.outcome).toMatchObject({ kind: "ok" });
	expect(approved.seen).toHaveLength(1);

	const declined = await run(await prepared("やめておきます", over), {
		choices: [{ choice: "decline", confirmation: "c1" }],
	});
	expect(names(declined.outcome)).toEqual([]);
	expect(declined.outcome).toMatchObject({ kind: "ok" });
	if (declined.outcome.kind === "ok")
		expect(declined.outcome.text).not.toBe("");
});

test("an answer that copies the system part is not heard: the host says its fixed words instead", async () => {
	const m = await prepared();
	const copy = m.input.messages[0]!.content;
	const { outcome } = await run(m, {
		choices: [{ choice: "none" }],
		talk: copy,
	});
	if (outcome.kind !== "ok") throw new Error("unreachable");
	expect(outcome.text).not.toBe("");
	expect(outcome.text).not.toContain(copy.slice(0, 40));
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
