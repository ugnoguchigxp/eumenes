/** What an experiment freezes: every file whose content decides a result. */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { caseFilesOf, type ExperimentConfig } from "./case-loader";
import type { FrozenFile } from "./freeze";
import { CONTEXT_EVAL_TOML_DIR, JUDGE_RULES_SOURCE } from "./judge-rules";

const HARNESS_DIR = "api/domains/dialogue/eval/context";
/**
 * Harness files outside the library that run, score or analyze (the store wiring and the CLI), and the token
 * estimator: its coefficients decide the sizes, the fits and the prefix metrics of every result.
 */
const HARNESS_EXTRA = [
	"api/infrastructure/context-budget.ts",
	"api/domains/dialogue/test/context-eval/store-wiring.ts",
	"scripts/context-eval/cli.ts",
	"scripts/context-eval/commands.ts",
	"scripts/context-eval/arms.ts",
	"scripts/context-eval/live.ts",
];

/** Every harness source: the whole library folder, plus the wiring and CLI. All are frozen by sha256. */
export function harnessSources(repoRoot: string): string[] {
	const library = readdirSync(resolve(repoRoot, HARNESS_DIR))
		.filter((name) => name.endsWith(".ts"))
		.sort()
		.map((name) => `${HARNESS_DIR}/${name}`);
	return [...library, ...HARNESS_EXTRA];
}

/** The system-context tomls of the evaluation (the arms' prose and the judge's rules): all are frozen. */
function contextEvalTomls(repoRoot: string): string[] {
	return readdirSync(resolve(repoRoot, CONTEXT_EVAL_TOML_DIR))
		.filter((name) => name.endsWith(".context.toml"))
		.sort()
		.filter((name) => `${CONTEXT_EVAL_TOML_DIR}/${name}` !== JUDGE_RULES_SOURCE)
		.map((name) => `${CONTEXT_EVAL_TOML_DIR}/${name}`);
}

export function frozenFilesOf(
	repoRoot: string,
	experimentDir: string,
	config: ExperimentConfig,
): FrozenFile[] {
	const rel = (path: string) => relative(repoRoot, path).split(sep).join("/");
	const read = (path: string): FrozenFile => ({
		path: rel(path),
		bytes: readFileSync(path),
	});
	const files: FrozenFile[] = [
		read(join(experimentDir, "experiment.json")),
		read(join(experimentDir, "PREREGISTRATION.md")),
		...caseFilesOf(experimentDir).map((file) => ({
			...read(file.path),
			holdout: /-holdout-\d{2}\.json$/.test(file.name),
		})),
		read(resolve(repoRoot, JUDGE_RULES_SOURCE)),
		...contextEvalTomls(repoRoot).map((path) => read(resolve(repoRoot, path))),
		...harnessSources(repoRoot).map((path) => read(resolve(repoRoot, path))),
	];
	if (config.toolsCatalog)
		files.push(read(join(experimentDir, config.toolsCatalog)));
	for (const arm of config.arms)
		if (arm.module) {
			const path = resolve(experimentDir, arm.module);
			if (!existsSync(path))
				throw new Error(`context_eval_arm_module_missing:${arm.module}`);
			files.push(read(path));
		}
	return files;
}

/**
 * The preregistration's re-run condition is filled in: a line `- 再実行の条件: <text>` whose text is not empty and
 * does not still say 要合意. A transport-error re-run is refused until then.
 */
export function rerunConditionFilled(preregistration: string): boolean {
	const match = /^[-*]\s*再実行の条件[:：]\s*(.*)$/m.exec(preregistration);
	const body = match?.[1]?.trim() ?? "";
	return body !== "" && !body.includes("要合意");
}
