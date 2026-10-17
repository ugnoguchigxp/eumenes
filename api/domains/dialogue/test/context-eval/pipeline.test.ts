import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	analyzeScores,
	prepare,
	run,
	score,
} from "../../../../../scripts/context-eval/commands";
import { loadCases } from "../../eval/context/case-loader";
import { FreezeConflict } from "../../eval/context/freeze";
import {
	createFixtureRunner,
	fixtureJudge,
} from "../../eval/context/fixture-lane";
import { readJudgeRulesSource } from "../../eval/context/judge-rules";
import {
	ALL_CASES,
	DEV_CASES,
	FIXTURE_ARMS,
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
const cases = loadCases;
const base = (dir: string) => ({
	lane: "fixture" as const,
	serialization: "larm-messages" as const,
	runner: createFixtureRunner(cases(dir)),
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
			"api/domains/dialogue/contexts/context-eval/arm-frames.context.toml",
			"api/domains/dialogue/eval/context/judge.ts",
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
	const calls = ALL_CASES * FIXTURE_ARMS.length * TRIALS;
	expect(ran.rows).toHaveLength(calls);
	expect(
		JSON.parse(readFileSync(join(ran.dir, "run.json"), "utf8")),
	).toMatchObject({ lane: "fixture", serialization: "larm-messages" });
	expect(
		readFileSync(join(ran.dir, "raw.jsonl"), "utf8").trim().split("\n"),
	).toHaveLength(calls);
	// The trajectory measurement is written with the run, ordering variants included.
	const prefix = JSON.parse(readFileSync(join(ran.dir, "prefix.json"), "utf8"));
	expect(Object.keys(prefix.arms).sort()).toEqual([
		"A0",
		"A0-aa",
		"A0-o2",
		"A2",
		"A2-o2",
	]);
	const scored = await score(ctx, dir, ran.dir, {
		judge: fixtureJudge,
		rules: readJudgeRulesSource(repoRoot),
		judgeSource: "toml-source",
	});
	expect(scored.scores).toHaveLength(calls);
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
	expect(md).toContain("prefix の安定度");
	const json = JSON.parse(
		readFileSync(join(analysed.dir, "RESULTS.json"), "utf8"),
	);
	expect(json).toMatchObject({
		lane: "fixture",
		binding: false,
		split: "holdout",
	});
	// The A/A control shows no difference, so it is not adopted.
	const aa = json.comparisons.find((c: { arm: string }) => c.arm === "A0-aa");
	expect(aa).toMatchObject({ net: 0, decision: "not_binding" });
	// Criterion 7 is measured from the run's own trajectory, not from a hand-made file.
	expect(aa.criteria.find((k: { id: number }) => k.id === 7).status).not.toBe(
		"not_measured",
	);
	expect(json.manifestSha256).toMatch(/^[0-9a-f]{64}$/);
});

test("the flattened lane is a run option recorded in run.json, and every row sends the flattened prompt", async () => {
	const { dir, ctx } = experiment();
	const larm = await run(ctx, dir, { ...base(dir), split: "dev" });
	const flat = await run(ctx, dir, {
		...base(dir),
		serialization: "flattened",
		split: "dev",
	});
	expect(
		JSON.parse(readFileSync(join(flat.dir, "run.json"), "utf8")).serialization,
	).toBe("flattened");
	expect(
		JSON.parse(readFileSync(join(flat.dir, "prefix.json"), "utf8")),
	).toMatchObject({ serialization: "flattened" });
	// Same arms, cases and trials; a different prompt (the message boundaries are gone).
	const hash = (rows: typeof larm.rows, arm: string) =>
		rows.find(
			(r) => r.arm === arm && r.caseId === "ctx-f3-dev-01" && r.trial === 1,
		)!.promptSha256;
	expect(flat.rows).toHaveLength(larm.rows.length);
	expect(hash(flat.rows, "A2")).not.toBe(hash(larm.rows, "A2"));
});
