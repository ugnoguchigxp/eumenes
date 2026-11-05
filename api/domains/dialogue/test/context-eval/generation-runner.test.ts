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
test("a generation without an utterance only talks, and may stay silent", async () => {
	const { outcome, seen } = await run(await prepared(null), { talk: "" });
	expect(outcome).toEqual({ kind: "ok", text: "", toolCalls: [] });
	expect(seen).toHaveLength(1);
	expect(seen[0]!.schema).toBeUndefined();
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
