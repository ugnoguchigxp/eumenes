import { afterEach, expect, test } from "bun:test";
import { baselineArm } from "../../eval/context/arm";
import { caseSchema } from "../../eval/context/case-schema";
import { type Materialized, materialize } from "../../eval/context/materialize";
import { parseRecallBlock } from "../../../memory";
import { renderInvariantIssues } from "../../eval/context/render-invariants";
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
		operation: {
			kind: "image",
			result: {
				id: "4c1d0b52-7a53-4a1e-9b61-0d2f5e3a8c11",
				runId: "r-seed",
				conversationId: "main",
				state: "failed",
				action: "generate",
				title: "夕焼けの海",
				description: "夕方の海",
				prompt: null,
				width: 1024,
				height: 768,
				format: "png",
				seed: null,
				phase: "failed",
				artifactId: null,
				mime: null,
				actualModel: null,
				errorCode: "image_upstream_timeout",
				createdAt: 1760630400000,
				updatedAt: 1760630460000,
			},
		},
		recall: [
			{
				user: "京都の宿はどこがいい",
				assistant: "駅近が便利です",
				at: "2026-09-01T09:30:00.000Z",
			},
		],
		specialist: {
			work: {
				suspended: {
					specialist: "図の担当",
					toolchainId: "diagram",
					label: "旅程の図",
					unsaved: true,
					savedRef: null,
					expiresAt: "2026-10-13T00:00:00.000Z",
				},
			},
			viewing: {
				specialist: "図の担当",
				toolchainId: "diagram",
				ref: "item-1",
				label: "旅程の図",
			},
			handoff: "今日の天気を教えて",
		},
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

test("a fully seeded case materializes the product assembly with every part", async () => {
	const m = await materialize(fullCase, await openSeedWiring());
	open.push(m);
	const a = m.assembly;
	expect(a.persona.persona).toBe("maid");
	expect(a.stage).toBe("result");
	expect(a.stable.map((b) => b.source)).toEqual(["memory.long_term", "goals"]);
	expect(JSON.stringify(a.stable[0]!.body)).toContain("辛い物が好き");
	expect(JSON.stringify(a.stable[1]!.body)).toContain("来週までに資料を作る");
	expect(a.working.map((b) => b.source)).toEqual([
		"memory.summary",
		"memory.short_term",
	]);
	expect(JSON.stringify(a.working)).toContain("旅行先は京都に決まった");
	expect(JSON.stringify(a.working)).toContain("来週は出張");
	// The summarized exchange is shown only through the summary; the kept ones come first.
	expect(a.history.turns.map((t) => [t.layer, t.content])).toEqual([
		["keep", "保持の質問"],
		["keep", "保持の答え"],
		["unprocessed", "未処理の質問"],
		["unprocessed", "未処理の答え"],
		["unprocessed", "最新の質問"],
		["unprocessed", "最新の答え"],
	]);
	expect(a.input).toEqual({ role: "user", content: "辛くない店を教えて" });
	// The order createPrepare shows the volatile part in.
	expect(a.volatile.map((b) => b.source)).toEqual([
		"memory.notice",
		"memory.recall",
		"world.names",
		"specialist.work",
		"specialist.viewing",
		"specialist.handoff",
		"operation.image",
	]);
	const recall = a.volatile.find((b) => b.source === "memory.recall")!;
	expect(
		recall.body.kind === "text" && parseRecallBlock(recall.body.text),
	).toEqual([
		{
			at: "2026-09-01 18:30",
			user: "京都の宿はどこがいい",
			assistant: "駅近が便利です",
		},
	]);
	const world = a.volatile.find((b) => b.source === "world.names")!;
	expect(JSON.stringify(world.body)).toContain("「音声サービス」");
	// A0 is the product's own render of it, and it keeps the render invariants.
	const out = baselineArm.build(a);
	expect(renderInvariantIssues(baselineArm, a, out)).toEqual([]);
	expect(out.messages.some((x) => x.content.startsWith('{"imageResult"'))).toBe(
		true,
	);
});

function researchCase(research: {
	projection?: unknown;
	failureCode?: string;
}) {
	return caseSchema.parse({
		id: "ctx-f2-dev-01",
		family: "F2",
		split: "dev",
		seed: {
			world: [{ name: "音声サービス" }],
			notices: ["通知"],
			research,
		},
		input: "調べて",
		tools: "none",
		expect: { checks: [{ kind: "brief_spoken_reply" }], rubric: [] },
	});
}

test("a research success is a volatile report block; a failure drops the notices and the World names", async () => {
	const ok = await materialize(
		researchCase({ projection: { summary: "晴れ" } }),
		await openSeedWiring(),
	);
	open.push(ok);
	expect(ok.assembly.stage).toBe("result");
	expect(ok.assembly.volatile.map((b) => b.source)).toEqual([
		"memory.notice",
		"world.names",
		"research.result",
	]);
	const failed = await materialize(
		researchCase({ failureCode: "research_unavailable" }),
		await openSeedWiring(),
	);
	open.push(failed);
	expect(failed.assembly.volatile.map((b) => b.source)).toEqual([
		"research.failure",
	]);
	// The failure answer is the product's own failure path: the layers are dropped from the list.
	const out = baselineArm.build(failed.assembly);
	expect(out.messages.at(out.currentRequestIndex)?.content).toBe("調べて");
});

test("a case without seed data assembles the system part inputs and the input only", async () => {
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
	expect(m.assembly.stage).toBe("initial");
	expect(m.assembly.stable).toEqual([]);
	expect(m.assembly.working).toEqual([]);
	expect(m.assembly.volatile).toEqual([]);
	expect(m.assembly.history.turns).toEqual([]);
	expect(baselineArm.build(m.assembly).messages).toHaveLength(2);
});

test("notes added at the same time are ordered by the seed, so a case materializes to the same prompt every time", async () => {
	const notes = Array.from({ length: 12 }, (_, i) => ({
		kind: "memo" as const,
		text: `メモ${i + 1}`,
	}));
	const noted = caseSchema.parse({
		id: "ctx-f4-dev-01",
		family: "F4",
		split: "dev",
		seed: { notes },
		input: "メモを教えて",
		tools: "none",
		expect: { checks: [{ kind: "brief_spoken_reply" }], rubric: [] },
	});
	const build = async () => {
		const m = await materialize(noted, await openSeedWiring());
		open.push(m);
		return JSON.stringify(baselineArm.build(m.assembly).messages);
	};
	const first = await build();
	expect(await build()).toBe(first);
	const order = [...first.matchAll(/メモ(\d+)/g)].map((x) => Number(x[1]));
	// The product lists the newest note first; with one millisecond between notes that is the last of the seed.
	expect(order).toEqual(Array.from({ length: 12 }, (_, i) => 12 - i));
});
