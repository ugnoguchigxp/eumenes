import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { type ContextCase, caseSchema, caseSetIssues } from "./case-schema";

export class CaseSetInvalid extends Error {
	constructor(readonly issues: string[]) {
		super(`context_eval_cases_invalid\n${issues.join("\n")}`);
	}
}

/** Parses already-read case files (name and JSON text) and validates the set. Throws CaseSetInvalid. */
export function parseCaseFiles(
	files: ReadonlyArray<{ name: string; text: string }>,
): ContextCase[] {
	const issues: string[] = [];
	const cases: ContextCase[] = [];
	for (const file of files) {
		let json: unknown;
		try {
			json = JSON.parse(file.text);
		} catch {
			issues.push(`${file.name}: invalid_json`);
			continue;
		}
		const parsed = caseSchema.safeParse(json);
		if (!parsed.success) {
			for (const issue of parsed.error.issues)
				issues.push(
					`${file.name}: ${issue.path.join(".") || "(root)"}: ${issue.message}`,
				);
			continue;
		}
		if (file.name.replace(/\.json$/, "") !== parsed.data.id)
			issues.push(`${file.name}: file_name_must_equal_id`);
		cases.push(parsed.data);
	}
	issues.push(...caseSetIssues(cases));
	if (issues.length) throw new CaseSetInvalid(issues);
	return cases.sort((a, b) => a.id.localeCompare(b.id));
}

/** The case files of an experiment: every `*.json` under `<dir>/cases`, sorted by name. */
export function caseFilesOf(experimentDir: string) {
	const dir = join(experimentDir, "cases");
	return readdirSync(dir)
		.filter((name) => name.endsWith(".json"))
		.sort()
		.map((name) => ({
			name,
			path: join(dir, name),
			text: readFileSync(join(dir, name), "utf8"),
		}));
}

export function loadCases(experimentDir: string): ContextCase[] {
	return parseCaseFiles(caseFilesOf(experimentDir));
}

const experimentConfigSchema = z
	.object({
		name: z.string().min(1),
		trials: z.number().int().min(1).max(9).default(3),
		concurrency: z.number().int().min(1).max(2).default(2),
		/** The toolchains a search offers in the live lane (and the cards a seeded TODO names); fixture runs need none. */
		toolsCatalog: z.string().min(1).optional(),
		/** Adoption thresholds. Section 21.2 defaults apply to what is not written here. */
		adoption: z
			.object({
				minNetGain: z.number().int().min(0).default(0),
				maxLatencyRatio: z.number().positive().default(1),
			})
			.strict()
			.default({ minNetGain: 0, maxLatencyRatio: 1 }),
	})
	.strict();
export type ExperimentConfig = z.infer<typeof experimentConfigSchema>;

export function loadExperimentConfig(experimentDir: string): ExperimentConfig {
	const text = readFileSync(join(experimentDir, "experiment.json"), "utf8");
	return experimentConfigSchema.parse(JSON.parse(text));
}

const catalogSchema = z.array(
	z
		.object({
			id: z.string().min(1),
			title: z.string().min(1),
			summary: z.string().min(1),
			useWhen: z.array(z.string().min(1)),
		})
		.strict(),
);
export type CatalogEntry = z.infer<typeof catalogSchema>[number];

/** The toolchains of an experiment's catalog file (none when it declares no catalog). */
export function loadCatalog(
	experimentDir: string,
	config: ExperimentConfig,
): CatalogEntry[] {
	if (!config.toolsCatalog) return [];
	return catalogSchema.parse(
		JSON.parse(readFileSync(join(experimentDir, config.toolsCatalog), "utf8")),
	);
}
