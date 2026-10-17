import { afterEach, expect, test } from "bun:test";
import {
	appendFileSync,
	cpSync,
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
	rerunTransport,
	run,
	score,
	type Ctx,
} from "../../../../../scripts/context-eval/commands";
import { baselineAaArm, baselineCompileArm } from "../../eval/context/arm";
import { loadCases } from "../../eval/context/case-loader";
import {
	frozenFilesOf,
	harnessSources,
	rerunConditionFilled,
} from "../../eval/context/experiment";
import { loadExperimentConfig } from "../../eval/context/case-loader";
import {
	createFixtureRunner,
	fixtureJudge,
} from "../../eval/context/fixture-lane";
import { resolveJudgeRules } from "../../eval/context/judge-rules";
import { materialize, type SeedWiring } from "../../eval/context/materialize";
import {
	type RawRow,
	rawRowIssues,
	runMetaSchema,
} from "../../eval/context/raw";
import { planJobs, type ConversationRunner } from "../../eval/context/run";
import { makeCase } from "./case-fixtures";
import { openSeedWiring } from "./store-wiring";

const repoRoot = resolve(import.meta.dir, "../../../../..");
const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const RERUN_FILLED =
	"- 再実行の条件: transport_error の呼び出しだけを、新しい run ディレクトリで1回まで再実行する。";
/** A copy of the example experiment plus one holdout case; `rerun` fills in the preregistered re-run condition. */
function experiment(rerun = false) {
	const root = mkdtempSync(join(tmpdir(), "context-eval-integrity-"));
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
			seed: {},
			input: "今夜は眠りたいので飲み物を一つ選んで",
			tools: "none",
			expect: {
				checks: [{ kind: "brief_spoken_reply" }],
				rubric: [
					{ axis: "follows_current_request", condition: "眠りを妨げない" },
				],
			},
		}),
	);
	if (rerun) {
		const path = join(dir, "PREREGISTRATION.md");
		writeFileSync(
			path,
			readFileSync(path, "utf8").replace(/^- 再実行の条件:.*$/m, RERUN_FILLED),
		);
	}
	let tick = 0;
	const ctx: Ctx = {
		repoRoot,
		outRoot: join(root, "reports"),
		now: () => new Date(Date.UTC(2026, 9, 17, 9, 0, 0, ++tick)),
		log: () => {},
	};
	return { dir, ctx };
}
const base = (dir: string) => ({
	lane: "fixture" as const,
	runner: createFixtureRunner(loadCases(dir)),
	openWiring: openSeedWiring,
});
const lines = (path: string) => readFileSync(path, "utf8").trim().split("\n");

test("the freeze covers every harness source, and the manifest records each case's baseline prompt", async () => {
	const { dir, ctx } = experiment();
	const config = loadExperimentConfig(dir);
	const frozen = frozenFilesOf(repoRoot, dir, config).map((f) => f.path);
	for (const name of [
		"materialize.ts",
		"raw.ts",
		"prefix-stability.ts",
		"report.ts",
		"fixture-lane.ts",
		"judge-rules.ts",
		"freeze.ts",
	])
		expect(frozen).toContain(`api/domains/dialogue/eval/context/${name}`);
	for (const name of ["live.ts", "commands.ts", "cli.ts", "arms.ts"])
		expect(frozen).toContain(`scripts/context-eval/${name}`);
	expect(harnessSources(repoRoot).length).toBeGreaterThan(15);
	const { manifest } = await prepare(ctx, dir, openSeedWiring);
	expect(Object.keys(manifest.baselinePrompts)).toEqual([
		"ctx-f1-dev-01",
		"ctx-f1-holdout-01",
		"ctx-f3-dev-01",
		"ctx-f9-dev-01",
	]);
	for (const hash of Object.values(manifest.baselinePrompts))
		expect(hash).toMatch(/^[0-9a-f]{64}$/);
});

test("a run refuses when the baseline prompt no longer matches the frozen one (product prompt building changed)", async () => {
	const { dir, ctx } = experiment();
	await prepare(ctx, dir, openSeedWiring);
	const changed = {
		id: "baseline-compile",
		build: (m: Parameters<typeof baselineCompileArm.build>[0]) => {
			const out = baselineCompileArm.build(m);
			return {
				...out,
				messages: [
					{ role: "system" as const, content: "追加された規則" },
					...out.messages,
				],
			};
		},
	};
	await expect(
		run(ctx, dir, {
			...base(dir),
			split: "all",
			arms: [changed, baselineAaArm],
		}),
	).rejects.toThrow(/context_eval_baseline_prompt_changed:ctx-f1-dev-01/);
	// Unchanged arms run fine.
	const ok = await run(ctx, dir, { ...base(dir), split: "all" });
	expect(ok.rows).toHaveLength(24);
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

test("score refuses raw rows that do not belong to the run: duplicates, unknown arm or case, trial out of range, lane", async () => {
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
				{ ...first, arm: "ghost" },
				{ ...first, caseId: "ctx-f1-dev-99", trial: 4 },
				{ ...first, lane: "live" },
			],
			meta,
		),
	).toEqual([
		"ghost|ctx-f1-dev-01|1: unknown_arm",
		"baseline-compile|ctx-f1-dev-99|4: unknown_case",
		"baseline-compile|ctx-f1-dev-99|4: trial_out_of_range",
		"baseline-compile|ctx-f1-dev-01|1: lane_mismatch",
		"baseline-compile|ctx-f1-dev-01|1: duplicate_row",
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
	const casePath = join(dir, "cases/ctx-f1-holdout-01.json");
	writeFileSync(
		casePath,
		readFileSync(casePath, "utf8").replace("眠りたい", "休みたい"),
	);
	await expect(score(ctx, dir, ran.dir, judge)).rejects.toThrow(
		"context_eval_frozen_content_changed",
	);
});

test("analyze refuses scores whose raw rows changed, malformed score rows, and an invalid or tampered prefix file", async () => {
	const { dir, ctx } = experiment();
	const ran = await run(ctx, dir, { ...base(dir), split: "dev" });
	const scored = await score(ctx, dir, ran.dir, {
		judge: fixtureJudge,
		rules: "R",
		judgeSource: "toml-source",
	});
	const prefixPath = join(dirs[0]!, "prefix.json");
	writeFileSync(
		prefixPath,
		JSON.stringify({
			"baseline-compile": { medianRatio: 0.9 },
			"baseline-compile-aa": { medianRatio: 0.9 },
		}),
	);
	const ok = analyzeScores(ctx, dir, scored.dir, { split: "dev", prefixPath });
	const results = JSON.parse(
		readFileSync(join(ok.dir, "RESULTS.json"), "utf8"),
	);
	expect(results.prefixSha256).toMatch(/^[0-9a-f]{64}$/);
	expect(readFileSync(join(ok.dir, "RESULTS.md"), "utf8")).toContain(
		results.prefixSha256,
	);
	writeFileSync(
		prefixPath,
		JSON.stringify({ "baseline-compile": { medianRatio: 2 } }),
	);
	expect(() =>
		analyzeScores(ctx, dir, scored.dir, { split: "dev", prefixPath }),
	).toThrow();
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
		fail: (call: { arm: string; caseId: string; trial: number }) => boolean,
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
		createFixtureRunner(loadCases(closed.dir)),
	);
	const source = await run(closed.ctx, closed.dir, {
		...base(closed.dir),
		runner: failing,
		split: "dev",
	});
	expect(
		source.rows.filter((r) => r.status === "transport_error"),
	).toHaveLength(2);
	await expect(
		rerunTransport(closed.ctx, closed.dir, source.dir, base(closed.dir)),
	).rejects.toThrow("context_eval_rerun_condition_not_preregistered");

	const { dir, ctx } = experiment(true);
	await prepare(ctx, dir, openSeedWiring);
	const first = await run(ctx, dir, {
		...base(dir),
		runner: flaky(
			(c) => c.trial === 2 && c.caseId === "ctx-f9-dev-01",
			createFixtureRunner(loadCases(dir)),
		),
		split: "all",
	});
	const originalRaw = readFileSync(join(first.dir, "raw.jsonl"), "utf8");
	const again = await rerunTransport(ctx, dir, first.dir, base(dir));
	expect(again.dir).not.toBe(first.dir);
	expect(again.replaced).toEqual([
		"baseline-compile-aa|ctx-f9-dev-01|2",
		"baseline-compile|ctx-f9-dev-01|2",
	]);
	// The source run is untouched.
	expect(readFileSync(join(first.dir, "raw.jsonl"), "utf8")).toBe(originalRaw);
	const rows = lines(join(again.dir, "raw.jsonl")).map(
		(l) => JSON.parse(l) as RawRow,
	);
	expect(rows).toHaveLength(24);
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
	expect(lines(join(again.dir, "replaced.jsonl"))).toHaveLength(2);
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
});

test("materialize closes the store when seeding throws, and planJobs closes it when an arm fails", async () => {
	let closed = 0;
	const real = await openSeedWiring();
	const failing: SeedWiring = {
		...real,
		saveItem: async () => {
			throw new Error("seed_failed");
		},
		close: async () => {
			closed++;
			await real.close();
		},
	};
	const seeded = makeCase("ctx-f1-dev-01", "あ", {
		seed: { longTerm: [{ kind: "preference", key: "k", text: "t" }] },
	});
	await expect(materialize(seeded, failing)).rejects.toThrow("seed_failed");
	expect(closed).toBe(1);
	let opened = 0;
	let closedByPlan = 0;
	const explode = {
		id: "boom",
		build: () => {
			throw new Error("build_failed");
		},
	};
	await expect(
		planJobs({
			cases: [makeCase("ctx-f9-dev-01", "こんにちは")],
			arms: [explode],
			trials: 1,
			openWiring: async () => {
				opened++;
				const w = await openSeedWiring();
				return {
					...w,
					close: async () => {
						closedByPlan++;
						await w.close();
					},
				};
			},
		}),
	).rejects.toThrow("build_failed");
	expect([opened, closedByPlan]).toEqual([1, 1]);
});
