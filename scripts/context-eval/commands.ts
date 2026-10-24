/** The context-eval subcommands as plain functions (cli.ts parses arguments and wires the lanes). */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import {
	type PrefixInput,
	analyze,
} from "../../api/domains/dialogue/eval/context/analysis";
import {
	loadCases,
	loadCatalog,
	loadExperimentConfig,
} from "../../api/domains/dialogue/eval/context/case-loader";
import {
	frozenFilesOf,
	rerunConditionFilled,
} from "../../api/domains/dialogue/eval/context/experiment";
import {
	MANIFEST_NAME,
	appendReportLine,
	buildManifest,
	createReportDir,
	freeze,
	verifyFrozen,
	writeReportFile,
} from "../../api/domains/dialogue/eval/context/freeze";
import type { ConversationRunner } from "../../api/domains/dialogue/eval/context/generation-runner";
import type { JudgeFn } from "../../api/domains/dialogue/eval/context/judge";
import {
	type SeedWiring,
	materialize,
} from "../../api/domains/dialogue/eval/context/materialize";
import { assertMessageInvariants } from "../../api/domains/dialogue/eval/context/message-invariants";
import {
	COMPARED_TRAJECTORY,
	type PrefixReport,
	measurePrefix,
	prefixReportSchema,
} from "../../api/domains/dialogue/eval/context/prefix-measure";
import { promptHash } from "../../api/domains/dialogue/eval/context/prefix-stability";
import {
	type Lane,
	type RawRow,
	type RunMeta,
	parseRawLines,
	rawRowIssues,
	rowKey,
	runMetaSchema,
} from "../../api/domains/dialogue/eval/context/raw";
import {
	resultsJson,
	resultsMarkdown,
} from "../../api/domains/dialogue/eval/context/report";
import { executeRun } from "../../api/domains/dialogue/eval/context/run";
import {
	adjudicationSchema,
	noAdjudication,
	scoreTrial,
	trialScoreSchema,
} from "../../api/domains/dialogue/eval/context/scoring";

export type Ctx = {
	repoRoot: string;
	/** Parent of the per-experiment report directories. */
	outRoot: string;
	now: () => Date;
	log: (line: string) => void;
};
export const defaultCtx = (repoRoot: string): Ctx => ({
	repoRoot,
	outRoot: join(repoRoot, "verification-reports", "context-eval"),
	now: () => new Date(),
	log: (line) => console.log(line),
});

const PREFIX_FILE = "prefix.json";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const readText = (path: string) => readFileSync(path, "utf8");
const readJson = (path: string) => JSON.parse(readText(path)) as unknown;
const writeJson = (dir: string, name: string, value: unknown) =>
	writeReportFile(dir, name, `${JSON.stringify(value, null, 2)}\n`);
const manifestSha = (experimentDir: string) =>
	existsSync(join(experimentDir, MANIFEST_NAME))
		? sha(readText(join(experimentDir, MANIFEST_NAME)))
		: null;
export type SplitChoice = "dev" | "holdout" | "all";

export function validate(experimentDir: string) {
	const config = loadExperimentConfig(experimentDir);
	const cases = loadCases(experimentDir);
	return {
		config,
		cases,
		counts: {
			dev: cases.filter((c) => c.split === "dev").length,
			holdout: cases.filter((c) => c.split === "holdout").length,
		},
	};
}

/**
 * Validates, proves every case materializes through the production prepare within the message invariants and builds
 * identically twice, plays the trajectories, then freezes.
 */
export async function prepare(
	ctx: Ctx,
	experimentDir: string,
	openWiring: () => Promise<SeedWiring>,
) {
	const { config, cases, counts } = validate(experimentDir);
	const catalog = loadCatalog(experimentDir, config);
	for (const testCase of cases) {
		const builds: string[] = [];
		for (let pass = 0; pass < 2; pass++) {
			const m = await materialize(testCase, await openWiring(), { catalog });
			try {
				assertMessageInvariants(m.input, testCase.id);
				builds.push(promptHash(m.input.messages));
			} finally {
				await m.close();
			}
		}
		if (builds[0] !== builds[1])
			throw new Error(`context_eval_prompt_not_deterministic:${testCase.id}`);
	}
	// The trajectories must prepare, within the invariants, before anything is frozen.
	await measurePrefix({ openWiring, catalog });
	const manifest = buildManifest({
		experiment: config.name,
		frozenAt: ctx.now().toISOString(),
		files: frozenFilesOf(ctx.repoRoot, experimentDir, config),
	});
	const result = freeze(experimentDir, manifest);
	ctx.log(
		`${result.created ? "frozen" : "already frozen, unchanged"}: ${Object.keys(result.manifest.files).length} files, dev ${counts.dev}, holdout ${counts.holdout}`,
	);
	if (counts.holdout === 0) ctx.log("warning: no holdout cases");
	return { ...result, counts };
}

/** The frozen files must be unchanged. Returns the sha256 of manifest.json. */
function requireFrozen(ctx: Ctx, experimentDir: string) {
	const { config } = validate(experimentDir);
	const current = buildManifest({
		experiment: config.name,
		frozenAt: "",
		files: frozenFilesOf(ctx.repoRoot, experimentDir, config),
	});
	const changes = verifyFrozen(experimentDir, current);
	if (changes.length)
		throw new Error(
			`context_eval_frozen_content_changed\n${changes.map((c) => `${c.kind} ${c.path}`).join("\n")}`,
		);
	return sha(readText(join(experimentDir, MANIFEST_NAME)));
}

type RunBase = {
	lane: Lane;
	runner: ConversationRunner;
	openWiring: () => Promise<SeedWiring>;
	/** Live: identifier of the saved settings the run reads (see live.ts). Null for the fixture lane. */
	settingsSnapshot?: string | null;
};

/** What a run binds itself to: the manifest (required for holdout). */
function manifestBinding(
	ctx: Ctx,
	experimentDir: string,
	caseHasHoldout: boolean,
) {
	return caseHasHoldout
		? requireFrozen(ctx, experimentDir)
		: manifestSha(experimentDir);
}

export async function run(
	ctx: Ctx,
	experimentDir: string,
	options: RunBase & { split: SplitChoice },
) {
	const { config, cases: all } = validate(experimentDir);
	const cases = all.filter(
		(c) => options.split === "all" || c.split === options.split,
	);
	if (cases.length === 0)
		throw new Error(`context_eval_no_cases_for_split:${options.split}`);
	const manifestSha256 = manifestBinding(
		ctx,
		experimentDir,
		cases.some((c) => c.split === "holdout"),
	);
	const catalog = loadCatalog(experimentDir, config);
	const dir = createReportDir(ctx.outRoot, config.name, ctx.now());
	const meta: RunMeta = {
		format: "context-eval.run",
		experiment: config.name,
		lane: options.lane,
		split: options.split,
		startedAt: ctx.now().toISOString(),
		manifestSha256,
		settingsSnapshot: options.settingsSnapshot ?? null,
		trials: config.trials,
		concurrency: config.concurrency,
		caseIds: cases.map((c) => c.id),
	};
	writeJson(dir, "run.json", meta);
	// Criterion 6 reads this: the trajectories, prepared by the production code as this run sends them.
	writeJson(
		dir,
		PREFIX_FILE,
		await measurePrefix({ openWiring: options.openWiring, catalog }),
	);
	const rows: RawRow[] = [];
	await executeRun({
		lane: options.lane,
		cases,
		trials: config.trials,
		concurrency: config.concurrency,
		openWiring: options.openWiring,
		catalog,
		runner: options.runner,
		onRow: (row) => {
			rows.push(row);
			appendReportLine(dir, "raw.jsonl", row);
		},
	});
	const failed = rows.filter((r) => r.status === "transport_error").length;
	ctx.log(
		`run ${options.lane}: ${rows.length} calls, ${failed} transport errors -> ${dir}`,
	);
	return { dir, rows };
}

/** A run directory's run.json and raw rows, checked against each other. */
function readRun(runDir: string) {
	const meta = runMetaSchema.parse(readJson(join(runDir, "run.json")));
	const rawText = readText(join(runDir, "raw.jsonl"));
	const rows = parseRawLines(rawText);
	const issues = rawRowIssues(rows, meta);
	if (issues.length)
		throw new Error(`context_eval_raw_rows_invalid\n${issues.join("\n")}`);
	return { meta, rows, rawText };
}

/**
 * The run's manifest binding still holds. A holdout run needs the freeze to be unchanged and to be the same
 * manifest the run was made under; a dev-only run records a mismatch instead of refusing.
 */
function manifestCheck(
	ctx: Ctx,
	experimentDir: string,
	meta: RunMeta,
	cases: ReturnType<typeof validate>["cases"],
): "match" | "mismatch" | "unfrozen" {
	const holdout = meta.caseIds.some(
		(id) => cases.find((c) => c.id === id)?.split === "holdout",
	);
	if (holdout) {
		const current = requireFrozen(ctx, experimentDir);
		if (meta.manifestSha256 !== current)
			throw new Error("context_eval_run_manifest_mismatch");
		return "match";
	}
	const current = manifestSha(experimentDir);
	if (meta.manifestSha256 === null && current === null) return "unfrozen";
	if (meta.manifestSha256 === current) return "match";
	ctx.log(
		"warning: the experiment's manifest differs from the one this run used",
	);
	return "mismatch";
}

/**
 * The sanctioned way to repeat transport errors: a NEW run directory holding the original rows, with only the
 * transport_error calls run again and replaced. Provenance is in run.json (`rerunOf`); the replaced rows are kept
 * in replaced.jsonl. Refused until the preregistration states its re-run condition.
 */
export async function rerunTransport(
	ctx: Ctx,
	experimentDir: string,
	sourceRunDir: string,
	options: RunBase,
) {
	const { config, cases } = validate(experimentDir);
	if (
		!rerunConditionFilled(readText(join(experimentDir, "PREREGISTRATION.md")))
	)
		throw new Error("context_eval_rerun_condition_not_preregistered");
	const { meta, rows, rawText } = readRun(sourceRunDir);
	if (meta.lane !== options.lane)
		throw new Error("context_eval_rerun_lane_mismatch");
	if (meta.settingsSnapshot !== (options.settingsSnapshot ?? null))
		throw new Error("context_eval_rerun_settings_changed");
	if (manifestCheck(ctx, experimentDir, meta, cases) === "mismatch")
		throw new Error("context_eval_run_manifest_mismatch");
	const failed = new Set(
		rows.filter((r) => r.status === "transport_error").map(rowKey),
	);
	if (failed.size === 0) throw new Error("context_eval_no_transport_errors");
	const dir = createReportDir(ctx.outRoot, config.name, ctx.now());
	writeJson(dir, "run.json", {
		...meta,
		startedAt: ctx.now().toISOString(),
		rerunOf: {
			runDir: resolve(sourceRunDir),
			sourceRawSha256: sha(rawText),
			replaced: [...failed].sort(),
		},
	} satisfies RunMeta);
	// The trajectory measurement belongs to the code, which a re-run does not change.
	writeReportFile(dir, PREFIX_FILE, readText(join(sourceRunDir, PREFIX_FILE)));
	const replacements = new Map<string, RawRow>();
	await executeRun({
		lane: options.lane,
		cases: cases.filter((c) => meta.caseIds.includes(c.id)),
		trials: meta.trials,
		concurrency: meta.concurrency,
		openWiring: options.openWiring,
		catalog: loadCatalog(experimentDir, config),
		runner: options.runner,
		only: (call) => failed.has(rowKey(call)),
		onRow: (row) => replacements.set(rowKey(row), row),
	});
	for (const row of rows) {
		const key = rowKey(row);
		const next = replacements.get(key);
		appendReportLine(dir, "raw.jsonl", next ?? row);
		if (next) appendReportLine(dir, "replaced.jsonl", row);
	}
	const stillFailing = [...replacements.values()].filter(
		(r) => r.status === "transport_error",
	).length;
	ctx.log(
		`rerun: ${replacements.size} calls replaced, ${stillFailing} still transport errors -> ${dir}`,
	);
	return { dir, replaced: [...replacements.keys()].sort() };
}

const scoreMetaSchema = z
	.object({
		format: z.literal("context-eval.score"),
		experiment: z.string(),
		lane: z.enum(["fixture", "live"]),
		runDir: z.string(),
		rawSha256: z.string(),
		judgeSource: z.string(),
		judgeRulesSha256: z.string(),
		adjudicationSha256: z.string().nullable(),
		manifestCheck: z.enum(["match", "mismatch", "unfrozen"]),
		settingsSnapshot: z.string().nullable(),
		trials: z.number().int().min(1),
		manifestSha256: z.string().nullable(),
	})
	.strict();

/** Scores every row of a run directory into a new scores directory. Re-runnable offline with any judge. */
export async function score(
	ctx: Ctx,
	experimentDir: string,
	runDir: string,
	options: {
		judge: JudgeFn;
		rules: string;
		adjudicationPath?: string;
		judgeSource: string;
	},
) {
	const { config, cases } = validate(experimentDir);
	const { meta, rows, rawText } = readRun(runDir);
	const check = manifestCheck(ctx, experimentDir, meta, cases);
	const adjudicationText = options.adjudicationPath
		? readText(options.adjudicationPath)
		: null;
	const adjudication = adjudicationText
		? adjudicationSchema.parse(JSON.parse(adjudicationText))
		: noAdjudication;
	const dir = createReportDir(ctx.outRoot, config.name, ctx.now());
	writeJson(dir, "score.json", {
		format: "context-eval.score",
		experiment: config.name,
		lane: meta.lane,
		runDir: resolve(runDir),
		rawSha256: sha(rawText),
		judgeSource: options.judgeSource,
		judgeRulesSha256: sha(options.rules),
		adjudicationSha256: adjudicationText ? sha(adjudicationText) : null,
		manifestCheck: check,
		settingsSnapshot: meta.settingsSnapshot,
		trials: meta.trials,
		manifestSha256: meta.manifestSha256,
	} satisfies z.infer<typeof scoreMetaSchema>);
	const scores = [];
	for (const row of rows) {
		const testCase = cases.find((c) => c.id === row.caseId);
		if (!testCase)
			throw new Error(`context_eval_raw_case_unknown:${row.caseId}`);
		const judge: JudgeFn = async (request) => {
			try {
				const reply = await options.judge(request);
				appendReportLine(dir, "judge.jsonl", {
					caseId: row.caseId,
					trial: row.trial,
					reply,
				});
				return reply;
			} catch (error) {
				appendReportLine(dir, "judge.jsonl", {
					caseId: row.caseId,
					trial: row.trial,
					errorClass: error instanceof Error ? error.name : "unknown",
				});
				throw error;
			}
		};
		const trial = await scoreTrial({
			row,
			case: testCase,
			judge,
			rules: options.rules,
			adjudication,
		});
		scores.push(trial);
		appendReportLine(dir, "scores.jsonl", trial);
	}
	ctx.log(
		`score: ${scores.length} trials, ${scores.filter((s) => s.status === "needs_adjudication").length} need adjudication -> ${dir}`,
	);
	return { dir, scores };
}

/** A scores directory read back and checked against the raw rows it was made from. */
function readScores(
	scoresDir: string,
	cases: ReturnType<typeof validate>["cases"],
) {
	const meta = scoreMetaSchema.parse(readJson(join(scoresDir, "score.json")));
	// The scores must be the ones made from the raw rows they name.
	const rawPath = join(resolve(meta.runDir), "raw.jsonl");
	if (!existsSync(rawPath)) throw new Error("context_eval_scores_raw_missing");
	const rawText = readText(rawPath);
	if (sha(rawText) !== meta.rawSha256)
		throw new Error("context_eval_scores_raw_changed");
	const scores = readText(join(scoresDir, "scores.jsonl"))
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line, index) => {
			try {
				return trialScoreSchema.parse(JSON.parse(line));
			} catch {
				throw new Error(`context_eval_score_row_invalid:line_${index + 1}`);
			}
		});
	const rawCount = parseRawLines(rawText).length;
	if (scores.length !== rawCount)
		throw new Error(
			`context_eval_scores_count_mismatch:${scores.length}/${rawCount}`,
		);
	for (const s of scores)
		if (!cases.some((c) => c.id === s.caseId))
			throw new Error(`context_eval_score_row_unknown:${s.caseId}`);
	// Criterion 6: the trajectory measurement the run wrote (prefix.json).
	const prefixPath = join(resolve(meta.runDir), PREFIX_FILE);
	const prefixText = existsSync(prefixPath) ? readText(prefixPath) : null;
	const prefix: PrefixReport | null = prefixText
		? prefixReportSchema.parse(JSON.parse(prefixText))
		: null;
	const compared: PrefixInput | null = prefix?.trajectories[COMPARED_TRAJECTORY]
		? {
				medianRatio: prefix.trajectories[COMPARED_TRAJECTORY]!.medianRatio,
			}
		: null;
	return { meta, scores, prefix, prefixText, compared };
}

/**
 * Analyzes one scores directory; with `baselineDir` (the scores of the same cases measured before the change) the two
 * runs are compared under the adoption rules.
 */
export function analyzeScores(
	ctx: Ctx,
	experimentDir: string,
	scoresDir: string,
	options: { split: "dev" | "holdout"; baselineDir?: string },
) {
	const { config, cases } = validate(experimentDir);
	const candidate = readScores(scoresDir, cases);
	const baseline = options.baselineDir
		? readScores(options.baselineDir, cases)
		: null;
	if (baseline && baseline.meta.lane !== candidate.meta.lane)
		throw new Error("context_eval_baseline_lane_mismatch");
	const analysis = analyze({
		lane: candidate.meta.lane,
		split: options.split,
		cases,
		candidate: {
			scores: candidate.scores,
			expectedTrials: candidate.meta.trials,
			prefix: candidate.compared,
		},
		...(baseline
			? {
					baseline: {
						scores: baseline.scores,
						expectedTrials: baseline.meta.trials,
						prefix: baseline.compared,
					},
				}
			: {}),
		thresholds: config.adoption,
	});
	const reportMeta = {
		experiment: config.name,
		generatedAt: ctx.now().toISOString(),
		manifestSha256: candidate.meta.manifestSha256,
		scoredFrom: resolve(scoresDir),
		baselineFrom: options.baselineDir ? resolve(options.baselineDir) : null,
		prefixSha256: candidate.prefixText ? sha(candidate.prefixText) : null,
		prefix: candidate.prefix,
	};
	const dir = createReportDir(ctx.outRoot, config.name, ctx.now());
	writeJson(dir, "RESULTS.json", resultsJson(analysis, reportMeta));
	writeReportFile(dir, "RESULTS.md", resultsMarkdown(analysis, reportMeta));
	ctx.log(
		analysis.comparison
			? `comparison with the baseline: ${analysis.comparison.decision} -> ${dir}`
			: `analysis of one run (no baseline) -> ${dir}`,
	);
	return { dir, analysis };
}
