import { afterEach, expect, test } from "bun:test";
import { caseSchema } from "../../eval/context/case-schema";
import { type Materialized, materialize } from "../../eval/context/materialize";
import { openSeedWiring } from "./store-wiring";

const open: Materialized[] = [];
afterEach(async () => {
	for (const m of open.splice(0)) await m.close();
});

const fullCase = caseSchema.parse({
	id: "ctx-f1-dev-01",
	family: "F1",
	split: "dev",
	seed: {
		persona: { agentName: "", userName: "", persona: "maid" },
		longTerm: [{ kind: "preference", key: "food.spicy", text: "辛い物が好き" }],
		notes: [{ kind: "memo", text: "来週は出張" }],
		summary: { text: "旅行先は京都に決まった", coversTurns: 1 },
		exchanges: [
			{
				user: "旅行先は？",
				assistant: "京都です",
				at: "2026-10-10T09:00:00.000Z",
				layer: "summarized",
			},
			{
				user: "保持の質問",
				assistant: "保持の答え",
				at: "2026-10-11T09:00:00.000Z",
				layer: "keep",
			},
			{
				user: "未処理の質問",
				assistant: "未処理の答え",
				at: "2026-10-12T09:00:00.000Z",
				layer: "unprocessed",
			},
			{
				user: "最新の質問",
				assistant: "最新の答え",
				at: "2026-10-12T10:00:00.000Z",
				layer: "unprocessed",
			},
		],
		goals: [{ text: "来週までに資料を作る", priority: 70 }],
		world: [{ name: "音声サービス" }],
		notices: ["メモの保存に失敗しました"],
		operation: { kind: "image", result: { status: "failed" } },
	},
	input: "辛くない店を教えて",
	tools: "none",
	expect: {
		checks: [],
		rubric: [
			{ axis: "follows_current_request", condition: "辛くない店を提案する" },
		],
	},
});

test("a fully seeded case compiles through the current compileContext with every layer", async () => {
	const m = await materialize(fullCase, await openSeedWiring());
	open.push(m);
	const texts = m.compiled.messages.map((x) => x.content);
	expect(m.compiled.messages[0]!.role).toBe("system");
	expect(m.compiled.sections.longTerm[0]!.content).toContain("辛い物が好き");
	expect(
		m.compiled.sections.working.map((x) => x.content).join("\n"),
	).toContain("旅行先は京都に決まった");
	expect(
		m.compiled.sections.working.map((x) => x.content).join("\n"),
	).toContain("来週は出張");
	expect(m.compiled.sections.history.map((x) => x.content)).toEqual([
		"保持の質問",
		"保持の答え",
	]);
	expect(m.compiled.sections.unprocessed.map((x) => x.content)).toEqual([
		"未処理の質問",
		"未処理の答え",
		"最新の質問",
		"最新の答え",
	]);
	// The summarized exchange is shown only through the summary.
	expect(texts).not.toContain("旅行先は？");
	expect(m.compiled.messages.at(-1)).toEqual({
		role: "user",
		content: "辛くない店を教えて",
	});
	expect(m.compiled.sections.tail[0]!.content).toContain(
		"- メモの保存に失敗しました",
	);
	expect(m.goalsLayer!.content).toContain("来週までに資料を作る");
	expect(m.worldHint!.content).toContain("「音声サービス」");
	expect(m.carried.operation).toEqual({
		kind: "image",
		result: { status: "failed" },
	});
});

test("a case without seed data compiles to the system prompt and the input", async () => {
	const bare = caseSchema.parse({
		id: "ctx-f9-dev-01",
		family: "F9",
		split: "dev",
		seed: {},
		input: "こんにちは",
		tools: "none",
		expect: { checks: [{ kind: "brief_spoken_reply" }], rubric: [] },
	});
	const m = await materialize(bare, await openSeedWiring());
	open.push(m);
	expect(m.compiled.messages).toHaveLength(2);
	expect(m.compiled.sections.tail).toEqual([]);
	expect(m.goalsLayer).toBeNull();
	expect(m.worldHint).toBeNull();
});
