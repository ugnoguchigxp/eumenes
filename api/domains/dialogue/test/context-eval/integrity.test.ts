import { afterEach, expect, test } from "bun:test";
import { appendFileSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
	analyzeScores,
	prepare,
	rerunTransport,
	run,
	score,
} from "../../../../../scripts/context-eval/commands";
import {
	loadCases,
	loadCatalog,
	loadExperimentConfig,
} from "../../eval/context/case-loader";
import {
	frozenFilesOf,
	harnessSources,
	rerunConditionFilled,
} from "../../eval/context/experiment";
import {
	createFixtureRunner,
	fixtureJudge,
} from "../../eval/context/fixture-lane";
import type { ConversationRunner } from "../../eval/context/generation-runner";
import { resolveJudgeRules } from "../../eval/context/judge-rules";
import {
	type RawRow,
	rawRowIssues,
	runMetaSchema,
} from "../../eval/context/raw";
import {
	ALL_CASES,
	DEV_CASES,
	HOLDOUT_CASE,
	RERUN_FILLED,
	TRIALS,
	makeExperiment,
	repoRoot,
} from "./experiment-fixture";
import { openSeedWiring } from "./store-wiring";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const experiment = (rerun = false) => makeExperiment(rerun, dirs);
const fixtureRunner = (dir: string) =>
	createFixtureRunner(
		loadCases(dir),
		loadCatalog(dir, loadExperimentConfig(dir)),
	);
const base = (dir: string) => ({
	lane: "fixture" as const,
	runner: fixtureRunner(dir),
	openWiring: openSeedWiring,
});
const lines = (path: string) => readFileSync(path, "utf8").trim().split("\n");

test("the freeze covers every harness source and the judge prompt, and nothing of the deleted arms", async () => {
	const { dir, ctx } = experiment();
	const config = loadExperimentConfig(dir);
	const frozen = frozenFilesOf(repoRoot, dir, config).map((f) => f.path);
	for (const name of [
		"materialize.ts",
		"session.ts",
		"session-context.ts",
		"generation-runner.ts",
		"message-invariants.ts",
		"raw.ts",
		"prefix-stability.ts",
		"prefix-measure.ts",
		"trajectory.ts",
		"report.ts",
		"fixture-lane.ts",
		"judge-rules.ts",
		"freeze.ts",
	])
		expect(frozen).toContain(`api/domains/dialogue/eval/context/${name}`);
	for (const name of ["live.ts", "commands.ts", "cli.ts"])
		expect(frozen).toContain(`scripts/context-eval/${name}`);
	expect(frozen).toContain(
		"api/domains/dialogue/contexts/context-eval/judge-rules.context.toml",
	);
	expect(frozen).toContain(
		"api/domains/dialogue/test/context-eval/store-wiring.ts",
	);
	expect(frozen.some((path) => /arm|ordering|serialization/.test(path))).toBe(
		false,
	);
	expect(harnessSources(repoRoot).length).toBeGreaterThan(15);
	const { manifest } = await prepare(ctx, dir, openSeedWiring);
	expect(Object.keys(manifest.files)).toEqual(
		expect.arrayContaining(
			[...DEV_CASES, HOLDOUT_CASE].map((id) =>
				expect.stringContaining(`${id}.json`),
			),
		),
	);
});

test("run.json records the settings snapshot and score.json the judge rules digest", async () => {
	const { dir, ctx } = experiment();
	const ran = await run(ctx, dir, {
		...base(dir),
		split: "dev",
		settingsSnapshot: "sha256:abc",
	});
	const meta = runMetaSchema.parse(
		JSON.parse(readFileSync(join(ran.dir, "run.json"), "utf8")),
	);
	expect(meta).toMatchObject({
		settingsSnapshot: "sha256:abc",
		manifestSha256: null,
	});
	const judging = resolveJudgeRules(repoRoot, "fixture");
	const scored = await score(ctx, dir, ran.dir, {
		judge: fixtureJudge,
		rules: judging.rules,
		judgeSource: judging.source,
	});
	const scoreMeta = JSON.parse(
		readFileSync(join(scored.dir, "score.json"), "utf8"),
	);
	expect(scoreMeta.judgeRulesSha256).toBe(judging.sha256);
	expect(scoreMeta.settingsSnapshot).toBe("sha256:abc");
	expect(scoreMeta.manifestCheck).toBe("unfrozen");
});

test("the catalog text of the judge rules is byte-identical to the frozen toml source (live lane check)", () => {
	const live = resolveJudgeRules(repoRoot, "live");
	expect(live.source).toBe("catalog");
	expect(live.sha256).toBe(resolveJudgeRules(repoRoot, "fixture").sha256);
});

test("score refuses raw rows that do not belong to the run: duplicates, unknown case, trial out of range, lane", async () => {
	const { dir, ctx } = experiment();
	const ran = await run(ctx, dir, { ...base(dir), split: "dev" });
	const first = JSON.parse(lines(join(ran.dir, "raw.jsonl"))[0]!) as RawRow;
	const judge = { judge: fixtureJudge, rules: "R", judgeSource: "toml-source" };
	const meta = runMetaSchema.parse(
		JSON.parse(readFileSync(join(ran.dir, "run.json"), "utf8")),
	);
	expect(
		rawRowIssues(
			[
				first,
				{ ...first, caseId: "ctx-f1-dev-99", trial: 4 },
				{ ...first, lane: "live" },
			],
			meta,
		),
	).toEqual([
		"ctx-f1-dev-99|4: unknown_case",
		"ctx-f1-dev-99|4: trial_out_of_range",
		"ctx-f1-dev-01|1: lane_mismatch",
		"ctx-f1-dev-01|1: duplicate_row",
	]);
	appendFileSync(join(ran.dir, "raw.jsonl"), `${JSON.stringify(first)}\n`);
	await expect(score(ctx, dir, ran.dir, judge)).rejects.toThrow(
		/duplicate_row/,
	);
});

test("score refuses a holdout run whose freeze changed; a dev run records a manifest mismatch", async () => {
	const { dir, ctx } = experiment();
	const devOnly = await run(ctx, dir, { ...base(dir), split: "dev" });
	await prepare(ctx, dir, openSeedWiring);
	const judge = { judge: fixtureJudge, rules: "R", judgeSource: "toml-source" };
	const dev = await score(ctx, dir, devOnly.dir, judge);
	expect(
		JSON.parse(readFileSync(join(dev.dir, "score.json"), "utf8")).manifestCheck,
	).toBe("mismatch");
	const ran = await run(ctx, dir, { ...base(dir), split: "all" });
	const ok = await score(ctx, dir, ran.dir, judge);
	expect(
		JSON.parse(readFileSync(join(ok.dir, "score.json"), "utf8")).manifestCheck,
	).toBe("match");
	const runJson = join(ran.dir, "run.json");
	const original = readFileSync(runJson, "utf8");
	writeFileSync(
		runJson,
		original.replace(/"manifestSha256": "[0-9a-f]+"/, '"manifestSha256": "0"'),
	);
	await expect(score(ctx, dir, ran.dir, judge)).rejects.toThrow(
		"context_eval_run_manifest_mismatch",
	);
	writeFileSync(runJson, original);
	const casePath = join(dir, `cases/${HOLDOUT_CASE}.json`);
	writeFileSync(
		casePath,
		readFileSync(casePath, "utf8").replace("眠りたい", "休みたい"),
	);
	await expect(score(ctx, dir, ran.dir, judge)).rejects.toThrow(
		"context_eval_frozen_content_changed",
	);
});

test("analyze refuses scores whose raw rows changed, malformed score rows, an invalid prefix measurement, and a baseline of another lane", async () => {
	const { dir, ctx } = experiment();
	const ran = await run(ctx, dir, { ...base(dir), split: "dev" });
	const scored = await score(ctx, dir, ran.dir, {
		judge: fixtureJudge,
		rules: "R",
		judgeSource: "toml-source",
	});
	const ok = analyzeScores(ctx, dir, scored.dir, { split: "dev" });
	const results = JSON.parse(
		readFileSync(join(ok.dir, "RESULTS.json"), "utf8"),
	);
	// The trajectory measurement the run wrote is what criterion 6 reads, with its digest in the report.
	expect(results.prefixSha256).toMatch(/^[0-9a-f]{64}$/);
	expect(readFileSync(join(ok.dir, "RESULTS.md"), "utf8")).toContain(
		results.prefixSha256,
	);
	const prefixPath = join(ran.dir, "prefix.json");
	const prefix = readFileSync(prefixPath, "utf8");
	writeFileSync(
		prefixPath,
		JSON.stringify({
			format: "context-eval.prefix",
			trajectories: { default: { medianRatio: 2, calls: [] } },
		}),
	);
	expect(() => analyzeScores(ctx, dir, scored.dir, { split: "dev" })).toThrow();
	writeFileSync(prefixPath, prefix);
	// A baseline measured in another lane cannot be compared.
	const scoreJson = join(scored.dir, "score.json");
	const meta = readFileSync(scoreJson, "utf8");
	writeFileSync(scoreJson, meta.replace('"lane": "fixture"', '"lane": "live"'));
	expect(() =>
		analyzeScores(ctx, dir, scored.dir, {
			split: "dev",
			baselineDir: scored.dir,
		}),
	).not.toThrow();
	const other = await score(ctx, dir, ran.dir, {
		judge: fixtureJudge,
		rules: "R",
		judgeSource: "toml-source",
	});
	expect(() =>
		analyzeScores(ctx, dir, scored.dir, {
			split: "dev",
			baselineDir: other.dir,
		}),
	).toThrow("context_eval_baseline_lane_mismatch");
	writeFileSync(scoreJson, meta);
	// Malformed score row.
	const scoresPath = join(scored.dir, "scores.jsonl");
	const good = readFileSync(scoresPath, "utf8");
	writeFileSync(scoresPath, good.replace('"trial":1', '"trial":"1"'));
	expect(() => analyzeScores(ctx, dir, scored.dir, { split: "dev" })).toThrow(
		/context_eval_score_row_invalid/,
	);
	writeFileSync(scoresPath, good);
	// Raw rows edited after scoring.
	appendFileSync(join(ran.dir, "raw.jsonl"), "\n");
	expect(() => analyzeScores(ctx, dir, scored.dir, { split: "dev" })).toThrow(
		"context_eval_scores_raw_changed",
	);
});

test("rerun condition: a line that is empty, missing or still says 要合意 is not filled in", () => {
	expect(rerunConditionFilled(RERUN_FILLED)).toBe(true);
	expect(rerunConditionFilled("- 再実行の条件: **要合意**（未記入）")).toBe(
		false,
	);
	expect(rerunConditionFilled("- 再実行の条件:")).toBe(false);
	expect(rerunConditionFilled("再実行はしない")).toBe(false);
});

const flaky =
	(
		fail: (call: { caseId: string; trial: number }) => boolean,
		inner: ConversationRunner,
	): ConversationRunner =>
	(call, signal) => {
		if (fail(call)) throw new TypeError("network down");
		return inner(call, signal);
	};

test("transport re-run: refused until preregistered; then a NEW run dir holds the original rows with only the failed calls replaced, with provenance", async () => {
	const closed = experiment(false);
	const failing = flaky(
		(c) => c.trial === 2 && c.caseId === "ctx-f9-dev-01",
		fixtureRunner(closed.dir),
	);
	const source = await run(closed.ctx, closed.dir, {
		...base(closed.dir),
		runner: failing,
		split: "dev",
	});
	expect(
		source.rows.filter((r) => r.status === "transport_error"),
	).toHaveLength(1);
	await expect(
		rerunTransport(closed.ctx, closed.dir, source.dir, base(closed.dir)),
	).rejects.toThrow("context_eval_rerun_condition_not_preregistered");

	const { dir, ctx } = experiment(true);
	await prepare(ctx, dir, openSeedWiring);
	const first = await run(ctx, dir, {
		...base(dir),
		runner: flaky(
			(c) => c.trial === 2 && c.caseId === "ctx-f9-dev-01",
			fixtureRunner(dir),
		),
		split: "all",
	});
	const originalRaw = readFileSync(join(first.dir, "raw.jsonl"), "utf8");
	const again = await rerunTransport(ctx, dir, first.dir, base(dir));
	expect(again.dir).not.toBe(first.dir);
	expect(again.replaced).toEqual(["ctx-f9-dev-01|2"]);
	// The source run is untouched.
	expect(readFileSync(join(first.dir, "raw.jsonl"), "utf8")).toBe(originalRaw);
	const rows = lines(join(again.dir, "raw.jsonl")).map(
		(l) => JSON.parse(l) as RawRow,
	);
	expect(rows).toHaveLength(ALL_CASES * TRIALS);
	expect(rows.filter((r) => r.status === "transport_error")).toHaveLength(0);
	const before = originalRaw
		.trim()
		.split("\n")
		.map((l) => JSON.parse(l) as RawRow);
	for (const [i, row] of rows.entries()) {
		const was = before[i]!;
		if (was.status !== "transport_error") expect(row).toEqual(was);
		else expect(row.status).toBe("ok");
	}
	const meta = runMetaSchema.parse(
		JSON.parse(readFileSync(join(again.dir, "run.json"), "utf8")),
	);
	expect(meta.rerunOf).toMatchObject({
		runDir: resolve(first.dir),
		replaced: again.replaced,
	});
	expect(meta.rerunOf!.sourceRawSha256).toMatch(/^[0-9a-f]{64}$/);
	expect(lines(join(again.dir, "replaced.jsonl"))).toHaveLength(1);
	// Nothing left to repeat, and a changed settings snapshot is refused.
	await expect(rerunTransport(ctx, dir, again.dir, base(dir))).rejects.toThrow(
		"context_eval_no_transport_errors",
	);
	await expect(
		rerunTransport(ctx, dir, first.dir, {
			...base(dir),
			settingsSnapshot: "sha256:other",
		}),
	).rejects.toThrow("context_eval_rerun_settings_changed");
	// The repaired run scores and analyzes.
	const scored = await score(ctx, dir, again.dir, {
		judge: fixtureJudge,
		rules: "R",
		judgeSource: "toml-source",
	});
	expect(
		scored.scores.filter((s) => s.status === "transport_error"),
	).toHaveLength(0);
	expect(
		analyzeScores(ctx, dir, scored.dir, { split: "holdout" }).analysis.run
			.transportErrors,
	).toBe(0);
});
