import { afterEach, expect, test } from "bun:test";
import {
	cpSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	analyzeScores,
	prepare,
	run,
	score,
	type Ctx,
} from "../../../../../scripts/context-eval/commands";
import { loadCases } from "../../eval/context/case-loader";
import { FreezeConflict } from "../../eval/context/freeze";
import {
	createFixtureRunner,
	fixtureJudge,
} from "../../eval/context/fixture-lane";
import { readJudgeRulesSource } from "../../eval/context/judge-rules";
import { openSeedWiring } from "./store-wiring";

const repoRoot = resolve(import.meta.dir, "../../../../..");
const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A copy of the example experiment with one holdout case added. */
function experiment() {
	const root = mkdtempSync(join(tmpdir(), "context-eval-pipeline-"));
	dirs.push(root);
	const dir = join(root, "exp");
	cpSync(
		join(repoRoot, "scripts/context-eval/experiments/2026-10-17-source-format"),
		dir,
		{ recursive: true },
	);
	writeFileSync(
		join(dir, "cases/ctx-f1-holdout-01.json"),
		JSON.stringify({
			id: "ctx-f1-holdout-01",
			family: "F1",
			split: "holdout",
			seed: {
				longTerm: [
					{ kind: "preference", key: "drink", text: "コーヒーが好き" },
				],
			},
			input: "今夜は眠りたいので飲み物を一つ選んで",
			tools: "none",
			expect: {
				checks: [{ kind: "brief_spoken_reply" }],
				rubric: [
					{
						axis: "follows_current_request",
						condition: "眠りを妨げない飲み物を選ぶ",
					},
				],
			},
		}),
	);
	let tick = 0;
	const ctx: Ctx = {
		repoRoot,
		outRoot: join(root, "reports"),
		now: () => new Date(Date.UTC(2026, 9, 17, 9, 0, 0, ++tick)),
		log: () => {},
	};
	return { dir, ctx };
}
const cases = loadCases;

test("prepare freezes once; changing a holdout case afterwards is refused by prepare and by run", async () => {
	const { dir, ctx } = experiment();
	const first = await prepare(ctx, dir, openSeedWiring);
	expect(first.created).toBe(true);
	expect(first.counts).toEqual({ dev: 3, holdout: 1 });
	expect(Object.keys(first.manifest.files)).toEqual(
		expect.arrayContaining([
			"api/domains/dialogue/contexts/context-eval/judge-rules.context.toml",
			"api/domains/dialogue/eval/context/judge.ts",
		]),
	);
	expect((await prepare(ctx, dir, openSeedWiring)).created).toBe(false);
	const path = join(dir, "cases/ctx-f1-holdout-01.json");
	writeFileSync(path, readFileSync(path, "utf8").replace("コーヒー", "紅茶"));
	await expect(prepare(ctx, dir, openSeedWiring)).rejects.toBeInstanceOf(
		FreezeConflict,
	);
	await expect(
		run(ctx, dir, {
			lane: "fixture",
			split: "holdout",
			runner: createFixtureRunner(cases(dir)),
			openWiring: openSeedWiring,
		}),
	).rejects.toThrow("context_eval_frozen_content_changed");
});

test("holdout cases are not run before the freeze", async () => {
	const { dir, ctx } = experiment();
	await expect(
		run(ctx, dir, {
			lane: "fixture",
			split: "holdout",
			runner: createFixtureRunner(cases(dir)),
			openWiring: openSeedWiring,
		}),
	).rejects.toThrow("context_eval_not_frozen");
});

test("fixture lane: run, score and analyze produce reports labelled fixture, each in a new directory", async () => {
	const { dir, ctx } = experiment();
	await prepare(ctx, dir, openSeedWiring);
	const all = cases(dir);
	const ran = await run(ctx, dir, {
		lane: "fixture",
		split: "all",
		runner: createFixtureRunner(all),
		openWiring: openSeedWiring,
	});
	expect(ran.rows).toHaveLength(4 * 2 * 3);
	expect(JSON.parse(readFileSync(join(ran.dir, "run.json"), "utf8")).lane).toBe(
		"fixture",
	);
	expect(
		readFileSync(join(ran.dir, "raw.jsonl"), "utf8").trim().split("\n"),
	).toHaveLength(24);
	const scored = await score(ctx, dir, ran.dir, {
		judge: fixtureJudge,
		rules: readJudgeRulesSource(repoRoot),
		judgeSource: "toml-source",
	});
	expect(scored.scores).toHaveLength(24);
	expect(scored.dir).not.toBe(ran.dir);
	expect(existsSync(join(scored.dir, "judge.jsonl"))).toBe(true);
	// Scoring again from the same raw rows gives another new directory, not an overwrite.
	const again = await score(ctx, dir, ran.dir, {
		judge: fixtureJudge,
		rules: "x",
		judgeSource: "toml-source",
	});
	expect(again.dir).not.toBe(scored.dir);
	const analysed = analyzeScores(ctx, dir, scored.dir, { split: "holdout" });
	const md = readFileSync(join(analysed.dir, "RESULTS.md"), "utf8");
	expect(md).toContain("`fixture`");
	expect(md).toContain("採否に使えない");
	const json = JSON.parse(
		readFileSync(join(analysed.dir, "RESULTS.json"), "utf8"),
	);
	expect(json).toMatchObject({
		lane: "fixture",
		binding: false,
		split: "holdout",
	});
	// The A/A control shows no difference, so it is not adopted.
	expect(json.comparisons[0]).toMatchObject({
		arm: "baseline-compile-aa",
		net: 0,
	});
	expect(json.comparisons[0].decision).toBe("not_binding");
	expect(json.manifestSha256).toMatch(/^[0-9a-f]{64}$/);
});
