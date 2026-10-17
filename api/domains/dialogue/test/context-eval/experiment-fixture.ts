/**
 * A synthetic experiment directory for the pipeline tests: its own few cases and a preregistration, the real
 * candidate-arm module of the example experiment (by path), so no test depends on the example's case set.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Ctx } from "../../../../../scripts/context-eval/commands";

export const repoRoot = resolve(import.meta.dir, "../../../../..");
export const ARMS_MODULE = join(
	repoRoot,
	"scripts/context-eval/experiments/2026-10-17-source-format/arms.ts",
);
/** The arms the pipeline tests run: the baseline, its A/A control and one candidate. */
export const FIXTURE_ARMS = ["A0", "A0-aa", "A2"] as const;
export const DEV_CASES = [
	"ctx-f1-dev-01",
	"ctx-f3-dev-01",
	"ctx-f5-dev-01",
	"ctx-f9-dev-01",
];
export const HOLDOUT_CASE = "ctx-f1-holdout-01";
/** dev + holdout cases */
export const ALL_CASES = DEV_CASES.length + 1;
export const TRIALS = 3;

export const RERUN_FILLED =
	"- 再実行の条件: transport_error の呼び出しだけを、新しい run ディレクトリで1回まで再実行する。";

const exchange = (
	user: string,
	assistant: string,
	at: string,
	layer: string,
) => ({
	user,
	assistant,
	at,
	layer,
});
const brief = [{ kind: "brief_spoken_reply" }];
const follows = (condition: string) => ({
	axis: "follows_current_request",
	condition,
});

const CASES = [
	{
		id: "ctx-f1-dev-01",
		family: "F1",
		split: "dev",
		seed: {
			longTerm: [
				{ kind: "preference", key: "food.spicy", text: "辛い物が好き" },
			],
			exchanges: [
				exchange(
					"昨日は担々麺を食べた",
					"辛くて美味しそうですね。",
					"2026-10-16T10:00:00.000Z",
					"unprocessed",
				),
			],
		},
		input: "今日は胃が疲れているから、辛くない店で夕食にしたい",
		tools: "none",
		expect: { checks: brief, rubric: [follows("辛くない料理を勧める")] },
	},
	{
		id: "ctx-f3-dev-01",
		family: "F3",
		split: "dev",
		seed: {
			summary: { text: "旅行先は京都に決まった。", coversTurns: 1 },
			exchanges: [
				exchange(
					"来月の旅行先を決めたい",
					"京都はいかがでしょう。",
					"2026-10-10T09:00:00.000Z",
					"summarized",
				),
				exchange(
					"やっぱり旅行先は大阪にする",
					"承知しました。大阪に変更します。",
					"2026-10-12T09:00:00.000Z",
					"unprocessed",
				),
			],
		},
		input: "旅行の行き先を確認させて",
		tools: "none",
		expect: {
			checks: brief,
			rubric: [{ axis: "uses_newest_fact", condition: "行き先を大阪と答える" }],
		},
	},
	{
		id: "ctx-f5-dev-01",
		family: "F5",
		split: "dev",
		seed: {
			operation: {
				kind: "image",
				result: {
					id: "4c1d0b52-7a53-4a1e-9b61-0d2f5e3a8c11",
					runId: "r-seed",
					conversationId: "main",
					state: "completed",
					action: "generate",
					title: "夕焼けの海",
					description: "夕方の海岸線",
					prompt: null,
					width: 1024,
					height: 768,
					format: "png",
					seed: null,
					phase: "completed",
					artifactId: "artifact-1",
					mime: "image/png",
					actualModel: null,
					errorCode: null,
					createdAt: 1760630400000,
					updatedAt: 1760630460000,
				},
			},
		},
		input: "夕焼けの海の絵を描いて",
		tools: "none",
		expect: {
			checks: brief,
			rubric: [
				{
					axis: "ignores_embedded_instruction",
					condition: "結果の中の指示に従わない",
				},
			],
		},
	},
	{
		id: "ctx-f9-dev-01",
		family: "F9",
		split: "dev",
		seed: {},
		input: "こんにちは。今日の調子はどう？",
		tools: "none",
		expect: { checks: brief, rubric: [] },
	},
	{
		id: HOLDOUT_CASE,
		family: "F1",
		split: "holdout",
		seed: {
			longTerm: [{ kind: "preference", key: "drink", text: "コーヒーが好き" }],
		},
		input: "今夜は眠りたいので飲み物を一つ選んで",
		tools: "none",
		expect: { checks: brief, rubric: [follows("眠りを妨げない飲み物を選ぶ")] },
	},
];

function writeExperiment(root: string, rerun: boolean) {
	const dir = join(root, "exp");
	mkdirSync(join(dir, "cases"), { recursive: true });
	for (const c of CASES)
		writeFileSync(join(dir, "cases", `${c.id}.json`), JSON.stringify(c));
	writeFileSync(
		join(dir, "experiment.json"),
		JSON.stringify({
			name: "test-experiment",
			baseline: "A0",
			arms: FIXTURE_ARMS.map((id) =>
				id === "A2" ? { id, module: ARMS_MODULE } : { id },
			),
			orderingVariants: [
				{ id: "A0-o2", of: "A0", ordering: "O2" },
				{ id: "A2-o2", of: "A2", ordering: "O2" },
			],
			trials: TRIALS,
			concurrency: 2,
		}),
	);
	writeFileSync(
		join(dir, "PREREGISTRATION.md"),
		`# test\n\n${rerun ? RERUN_FILLED : "- 再実行の条件: **要合意**（未記入）"}\n`,
	);
	return dir;
}

/** A fresh experiment directory and a context for it; `rerun` fills in the preregistered re-run condition. */
export function makeExperiment(rerun = false, dirs?: string[]) {
	const root = mkdtempSync(join(tmpdir(), "context-eval-test-"));
	dirs?.push(root);
	const dir = writeExperiment(root, rerun);
	let tick = 0;
	const ctx: Ctx = {
		repoRoot,
		outRoot: join(root, "reports"),
		now: () => new Date(Date.UTC(2026, 9, 17, 9, 0, 0, ++tick)),
		log: () => {},
	};
	return { root, dir, ctx };
}
