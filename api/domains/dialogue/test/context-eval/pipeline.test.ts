import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	analyzeScores,
	prepare,
	run,
	score,
} from "../../../../../scripts/context-eval/commands";
import {
	loadCases,
	loadCatalog,
	loadExperimentConfig,
} from "../../eval/context/case-loader";
import {
	createFixtureRunner,
	fixtureJudge,
} from "../../eval/context/fixture-lane";
import { FreezeConflict } from "../../eval/context/freeze";
import { readJudgeRulesSource } from "../../eval/context/judge-rules";
import {
	ALL_CASES,
	DEV_CASES,
	HOLDOUT_CASE,
	TRIALS,
	makeExperiment,
	repoRoot,
} from "./experiment-fixture";
import { openSeedWiring } from "./store-wiring";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const experiment = () => makeExperiment(false, dirs);
const base = (dir: string) => ({
	lane: "fixture" as const,
	runner: createFixtureRunner(
		loadCases(dir),
		loadCatalog(dir, loadExperimentConfig(dir)),
	),
	openWiring: openSeedWiring,
});

test("prepare freezes once; changing a holdout case afterwards is refused by prepare and by run", async () => {
	const { dir, ctx } = experiment();
	const first = await prepare(ctx, dir, openSeedWiring);
	expect(first.created).toBe(true);
	expect(first.counts).toEqual({ dev: DEV_CASES.length, holdout: 1 });
	expect(Object.keys(first.manifest.files)).toEqual(
		expect.arrayContaining([
			"api/domains/dialogue/contexts/context-eval/judge-rules.context.toml",
			"api/domains/dialogue/eval/context/judge.ts",
			"api/domains/dialogue/eval/context/session.ts",
		]),
	);
	expect((await prepare(ctx, dir, openSeedWiring)).created).toBe(false);
	const path = join(dir, `cases/${HOLDOUT_CASE}.json`);
	writeFileSync(path, readFileSync(path, "utf8").replace("コーヒー", "紅茶"));
	await expect(prepare(ctx, dir, openSeedWiring)).rejects.toBeInstanceOf(
		FreezeConflict,
	);
	await expect(
		run(ctx, dir, { ...base(dir), split: "holdout" }),
	).rejects.toThrow("context_eval_frozen_content_changed");
});

test("prepare refuses a case whose messages break an invariant or cannot be prepared, before anything is frozen", async () => {
	const { dir, ctx } = experiment();
	const path = join(dir, "cases/ctx-f9-dev-01.json");
	const broken = JSON.parse(readFileSync(path, "utf8"));
	broken.seed = { modelWindow: 2000 };
	writeFileSync(path, JSON.stringify(broken));
	await expect(prepare(ctx, dir, openSeedWiring)).rejects.toThrow(
		"window_too_small",
	);
	expect(existsSync(join(dir, "manifest.json"))).toBe(false);
});

test("holdout cases are not run before the freeze", async () => {
	const { dir, ctx } = experiment();
	await expect(
		run(ctx, dir, { ...base(dir), split: "holdout" }),
	).rejects.toThrow("context_eval_not_frozen");
});

test("fixture lane: run, score and analyze produce reports labelled fixture, each in a new directory", async () => {
	const { dir, ctx } = experiment();
	await prepare(ctx, dir, openSeedWiring);
	const ran = await run(ctx, dir, { ...base(dir), split: "all" });
	const calls = ALL_CASES * TRIALS;
	expect(ran.rows).toHaveLength(calls);
	expect(ran.rows.every((r) => r.status === "ok")).toBe(true);
	expect(
		JSON.parse(readFileSync(join(ran.dir, "run.json"), "utf8")),
	).toMatchObject({ lane: "fixture", trials: TRIALS });
	expect(
		readFileSync(join(ran.dir, "raw.jsonl"), "utf8").trim().split("\n"),
	).toHaveLength(calls);
	// The trajectory measurement is written with the run.
	const prefix = JSON.parse(readFileSync(join(ran.dir, "prefix.json"), "utf8"));
	expect(Object.keys(prefix.trajectories).sort()).toEqual([
		"default",
		"smallWindow",
	]);
	const scored = await score(ctx, dir, ran.dir, {
		judge: fixtureJudge,
		rules: readJudgeRulesSource(repoRoot),
		judgeSource: "toml-source",
	});
	expect(scored.scores).toHaveLength(calls);
	expect(scored.scores.every((s) => s.pass === true)).toBe(true);
	expect(scored.dir).not.toBe(ran.dir);
	expect(existsSync(join(scored.dir, "judge.jsonl"))).toBe(true);
	// Scoring again from the same raw rows gives another new directory, not an overwrite.
	const again = await score(ctx, dir, ran.dir, {
		judge: fixtureJudge,
		rules: "x",
		judgeSource: "toml-source",
	});
	expect(again.dir).not.toBe(scored.dir);
	// One run on its own: a summary, no comparison.
	const alone = analyzeScores(ctx, dir, scored.dir, { split: "holdout" });
	expect(alone.analysis.comparison).toBeNull();
	const md = readFileSync(join(alone.dir, "RESULTS.md"), "utf8");
	expect(md).toContain("`fixture`");
	expect(md).toContain("採否に使えない");
	expect(md).toContain("prefix の安定度");
	expect(
		JSON.parse(readFileSync(join(alone.dir, "RESULTS.json"), "utf8")),
	).toMatchObject({ lane: "fixture", binding: false, split: "holdout" });
	// Against an earlier run of the same cases: a paired comparison, never binding in the fixture lane.
	const compared = analyzeScores(ctx, dir, scored.dir, {
		split: "holdout",
		baselineDir: again.dir,
	});
	expect(compared.analysis.comparison).toMatchObject({
		net: 0,
		decision: "not_binding",
	});
	// Criterion 6 is measured from the run's own trajectory, not from a hand-made file.
	expect(
		compared.analysis.comparison!.criteria.find((k) => k.id === 6)!.status,
	).not.toBe("not_measured");
	const json = JSON.parse(
		readFileSync(join(compared.dir, "RESULTS.json"), "utf8"),
	);
	expect(json.manifestSha256).toMatch(/^[0-9a-f]{64}$/);
	expect(json.baselineFrom).toBe(again.dir);
});
