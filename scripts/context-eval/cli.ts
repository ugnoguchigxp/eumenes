/**
 * context-eval CLI. Usage:
 *   bun scripts/context-eval/cli.ts validate --experiment <dir>
 *   bun scripts/context-eval/cli.ts prepare  --experiment <dir>
 *   bun scripts/context-eval/cli.ts run      --experiment <dir> [--live] [--split dev|holdout|all] [--serialization larm-messages|flattened]
 *   bun scripts/context-eval/cli.ts run      --experiment <dir> --rerun-transport <run dir>   (only transport_error calls, into a new run dir)
 *   bun scripts/context-eval/cli.ts score    --experiment <dir> --run <run dir> [--adjudication <file>]
 *   bun scripts/context-eval/cli.ts analyze  --experiment <dir> --scores <scores dir> [--split dev|holdout]
 * Reports go to verification-reports/context-eval/<experiment>/<timestamp>/ (new directories, never overwritten).
 * `--live` uses the saved LARM connection in this process; it never starts a server. Without it the fixture lane runs.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
	createFixtureRunner,
	fixtureJudge,
} from "../../api/domains/dialogue/eval/context/fixture-lane";
import { resolveJudgeRules } from "../../api/domains/dialogue/eval/context/judge-rules";
import { openSeedWiring } from "../../api/domains/dialogue/test/context-eval/store-wiring";
import {
	SERIALIZATIONS,
	type Serialization,
} from "../../api/domains/dialogue/eval/context/raw";
import {
	type SplitChoice,
	analyzeScores,
	defaultCtx,
	prepare,
	rerunTransport,
	run,
	score,
	validate,
} from "./commands";

const repoRoot = resolve(import.meta.dir, "../..");
const [command, ...rest] = process.argv.slice(2);

function option(name: string): string | undefined {
	const index = rest.indexOf(`--${name}`);
	return index >= 0 ? rest[index + 1] : undefined;
}
const flag = (name: string) => rest.includes(`--${name}`);
function required(name: string): string {
	const value = option(name);
	if (!value) throw new Error(`missing --${name}`);
	return resolve(value);
}
const splitOf = (fallback: SplitChoice): SplitChoice => {
	const value = option("split") ?? fallback;
	if (value !== "dev" && value !== "holdout" && value !== "all")
		throw new Error("invalid --split");
	return value;
};

const serializationOf = (): Serialization => {
	const value = option("serialization") ?? "larm-messages";
	const found = SERIALIZATIONS.find((s) => s === value);
	if (!found) throw new Error("invalid --serialization");
	return found;
};

async function main() {
	const ctx = defaultCtx(repoRoot);
	const experiment = required("experiment");
	switch (command) {
		case "validate": {
			const { counts, config } = validate(experiment);
			console.log(
				`valid: ${config.name}, dev ${counts.dev}, holdout ${counts.holdout}`,
			);
			return;
		}
		case "prepare":
			await prepare(ctx, experiment, openSeedWiring);
			return;
		case "run": {
			const rerunFrom = option("rerun-transport");
			const sourceDir = rerunFrom ? resolve(rerunFrom) : null;
			const sourceMeta = sourceDir
				? (JSON.parse(readFileSync(join(sourceDir, "run.json"), "utf8")) as {
						lane: string;
						serialization: Serialization;
					})
				: null;
			// A re-run keeps the lane and the serialization of the run it repairs.
			const live = sourceMeta ? sourceMeta.lane === "live" : flag("live");
			const { config, cases } = validate(experiment);
			const liveModule = live ? await import("./live") : null;
			const lane = liveModule
				? await liveModule.createLiveLane(experiment, config.toolsCatalog)
				: null;
			try {
				const common = {
					lane: live ? ("live" as const) : ("fixture" as const),
					serialization: sourceMeta
						? sourceMeta.serialization
						: serializationOf(),
					runner: lane ? lane.runner : createFixtureRunner(cases),
					openWiring: openSeedWiring,
					settingsSnapshot: liveModule
						? liveModule.liveSettingsSnapshot()
						: null,
				};
				if (sourceDir) await rerunTransport(ctx, experiment, sourceDir, common);
				else
					await run(ctx, experiment, {
						...common,
						split: splitOf(live ? "holdout" : "dev"),
					});
			} finally {
				await lane?.close();
			}
			return;
		}
		case "score": {
			const runDir = required("run");
			const live =
				JSON.parse(readFileSync(join(runDir, "run.json"), "utf8")).lane ===
				"live";
			const lane = live
				? await import("./live").then((m) =>
						m.createLiveLane(experiment, undefined),
					)
				: null;
			try {
				const adjudicationPath = option("adjudication");
				// The live lane stops here if the catalog text differs from the frozen toml.
				const judging = resolveJudgeRules(repoRoot, live ? "live" : "fixture");
				await score(ctx, experiment, runDir, {
					judge: lane ? lane.judge : fixtureJudge,
					rules: judging.rules,
					judgeSource: judging.source,
					...(adjudicationPath
						? { adjudicationPath: resolve(adjudicationPath) }
						: {}),
				});
			} finally {
				await lane?.close();
			}
			return;
		}
		case "analyze": {
			const split = splitOf("holdout");
			if (split === "all")
				throw new Error("analyze needs --split dev or holdout");
			analyzeScores(ctx, experiment, required("scores"), { split });
			return;
		}
		default:
			throw new Error(
				"usage: cli.ts validate|prepare|run|score|analyze --experiment <dir>",
			);
	}
}

await main();
