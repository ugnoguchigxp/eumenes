import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { systemContext } from "../../../../infrastructure/system-context";

/** Repository-relative folder of the evaluation's system-context tomls. */
export const CONTEXT_EVAL_TOML_DIR =
	"api/domains/dialogue/contexts/context-eval";
/** Repository-relative source of the judge prompt (a system-context toml); frozen by its sha256. */
export const JUDGE_RULES_SOURCE = `${CONTEXT_EVAL_TOML_DIR}/judge-rules.context.toml`;

/** The judge's rules text. Needs the system-context catalog to have been rebuilt with the toml. */
function loadJudgeRules(): string {
	return systemContext("dialogue.contexts.context-eval.judge-rules", {});
}

/**
 * The same text read from the toml source, for runs that must not depend on a rebuilt catalog (the fixture lane,
 * whose fake judge ignores the rules). A live judge uses `loadJudgeRules`.
 */
export function readJudgeRulesSource(repoRoot: string): string {
	const source = readFileSync(resolve(repoRoot, JUDGE_RULES_SOURCE), "utf8");
	const match = /text = '''\n?([\s\S]*?)'''/.exec(source);
	if (!match) throw new Error("context_eval_judge_rules_source_invalid");
	return match[1]!;
}

const digest = (text: string) =>
	createHash("sha256").update(text).digest("hex");

/**
 * The rules a lane scores with. The live lane uses the catalog text (what product code reads) but only when it is
 * byte-identical to the frozen toml source; a stale catalog stops the run (`context:build` was not re-run).
 */
export function resolveJudgeRules(
	repoRoot: string,
	lane: "fixture" | "live",
): { rules: string; sha256: string; source: "catalog" | "toml-source" } {
	const source = readJudgeRulesSource(repoRoot);
	if (lane === "fixture")
		return { rules: source, sha256: digest(source), source: "toml-source" };
	const catalog = loadJudgeRules();
	if (digest(catalog) !== digest(source))
		throw new Error("context_eval_judge_rules_catalog_stale");
	return { rules: catalog, sha256: digest(catalog), source: "catalog" };
}
