import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { z } from "zod";
import { validateCriteriaItems } from "./checks";
import { FROZEN_ROOT, sha256, type FrozenSet } from "./frozen";
import {
	caseSchema,
	criteriaSchema,
	fixtureSchema,
	type CaseDef,
	type Criteria,
	type FixtureDef,
} from "./types";

/**
 * Cases that run but are not frozen: `tests/acceptance/nl/drafts/<group>/{cases,criteria,fixtures}`.
 * They use the same schemas and checks as the frozen set, but no lock covers them, so their
 * criteria may still change; a run records their file digests under `drafts/...`. A case whose
 * files do not parse, or whose criteria name a check the harness does not have, is listed as
 * skipped with the reason and cannot be run.
 */
export type DraftSkip = { caseId: string; reason: string };
export type Runnable = {
	set: FrozenSet;
	draftCaseIds: Set<string>;
	skipped: DraftSkip[];
};

function readAll<T>(
	dir: string,
	prefix: string,
	schema: z.ZodType<T>,
	digests: Record<string, string>,
	failed: Array<{ file: string; reason: string }>,
): Array<{ file: string; value: T }> {
	if (!existsSync(dir)) return [];
	const out: Array<{ file: string; value: T }> = [];
	for (const name of readdirSync(dir)
		.filter((n) => n.endsWith(".json"))
		.sort()) {
		const file = `${prefix}/${name}`;
		const bytes = readFileSync(join(dir, name));
		const parsed = schema.safeParse(JSON.parse(bytes.toString("utf8")));
		if (parsed.success) {
			digests[file] = sha256(bytes);
			out.push({ file, value: parsed.data });
		} else {
			const first = parsed.error.issues[0];
			failed.push({
				file,
				reason: `invalid_file ${file} ${first?.path.join(".")} ${first?.message}`,
			});
		}
	}
	return out;
}

/** Adds the runnable drafts to the frozen set. The frozen maps and digests are never changed. */
export function withDrafts(frozen: FrozenSet, root = FROZEN_ROOT): Runnable {
	const cases = new Map(frozen.cases);
	const criteria = new Map(frozen.criteria);
	const fixtures = new Map(frozen.fixtures);
	const digests = { ...frozen.digests };
	const draftCaseIds = new Set<string>();
	const skipped: DraftSkip[] = [];
	const draftsDir = join(root, "drafts");
	const groups = existsSync(draftsDir)
		? readdirSync(draftsDir, { withFileTypes: true })
				.filter((e) => e.isDirectory())
				.map((e) => e.name)
				.sort()
		: [];
	const draftCriteria = new Map<string, Criteria>();
	const draftFixtures = new Map<string, FixtureDef>();
	const draftCases: Array<{ file: string; value: CaseDef }> = [];
	const failed: Array<{ file: string; reason: string }> = [];
	for (const group of groups) {
		const base = join(draftsDir, group);
		const prefix = `drafts/${group}`;
		for (const { value } of readAll(
			join(base, "criteria"),
			`${prefix}/criteria`,
			criteriaSchema,
			digests,
			failed,
		))
			draftCriteria.set(`criteria:${value.criteriaId}@${value.version}`, value);
		for (const { value } of readAll(
			join(base, "fixtures"),
			`${prefix}/fixtures`,
			fixtureSchema,
			digests,
			failed,
		))
			draftFixtures.set(`fixture:${value.fixtureId}@${value.version}`, value);
		draftCases.push(
			...readAll(
				join(base, "cases"),
				`${prefix}/cases`,
				caseSchema,
				digests,
				failed,
			),
		);
	}
	for (const { file, reason } of failed)
		skipped.push({
			caseId: file
				.split("/")
				.pop()!
				.replace(/\.json$/, ""),
			reason,
		});
	for (const { file, value } of draftCases) {
		const criteriaDef =
			draftCriteria.get(value.criteriaRef) ??
			frozen.criteria.get(value.criteriaRef);
		const fixture =
			draftFixtures.get(value.initialStateRef) ??
			frozen.fixtures.get(value.initialStateRef);
		const reason = !criteriaDef
			? `unknown_criteria ${value.criteriaRef}`
			: criteriaDef.caseId !== value.caseId
				? "criteria_case_mismatch"
				: validateCriteriaItems(criteriaDef)[0]
					? `criteria_${validateCriteriaItems(criteriaDef)[0]}`
					: !fixture
						? `unknown_fixture ${value.initialStateRef}`
						: (fixture.stack === "product") !== value.requires.productLlm
							? "stack_requirement_mismatch"
							: frozen.cases.has(value.caseId)
								? "frozen_case_id_collision"
								: null;
		if (reason || !criteriaDef || !fixture) {
			skipped.push({ caseId: value.caseId, reason: reason ?? file });
			continue;
		}
		cases.set(value.caseId, value);
		criteria.set(value.criteriaRef, criteriaDef);
		fixtures.set(value.initialStateRef, fixture);
		draftCaseIds.add(value.caseId);
	}
	return {
		set: { ...frozen, cases, criteria, fixtures, digests },
		draftCaseIds,
		skipped,
	};
}
