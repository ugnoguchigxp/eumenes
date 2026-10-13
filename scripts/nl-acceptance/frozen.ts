import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { z } from "zod";
import { validateCriteriaItems } from "./checks";
import {
	caseSchema,
	criteriaSchema,
	fixtureSchema,
	lockSchema,
	pilotSchema,
	type CaseDef,
	type Criteria,
	type FixtureDef,
	type FrozenLock,
	type PilotPlan,
} from "./types";

export const FROZEN_ROOT = resolve(
	import.meta.dir,
	"../../tests/acceptance/nl",
);
const DIRS = ["cases", "criteria", "fixtures"] as const;
const PILOT = "pilot.json";
const LOCK = "frozen.lock.json";

export const sha256 = (bytes: string | Uint8Array) =>
	createHash("sha256").update(bytes).digest("hex");

/** Every frozen file (relative path), sorted. The lock itself is not part of the set. */
function frozenFiles(root: string): string[] {
	const files = DIRS.flatMap((dir) =>
		readdirSync(join(root, dir))
			.filter((name) => name.endsWith(".json"))
			.map((name) => `${dir}/${name}`),
	);
	return [...files, PILOT].sort();
}
function digests(root: string): Record<string, string> {
	return Object.fromEntries(
		frozenFiles(root).map((path) => [
			path,
			sha256(readFileSync(join(root, path))),
		]),
	);
}

/** Owner action: records the current digests. Only after the cases and criteria were reviewed. */
export function freeze(root = FROZEN_ROOT): FrozenLock {
	const lock: FrozenLock = { lockVersion: 1, files: digests(root) };
	writeFileSync(join(root, LOCK), `${JSON.stringify(lock, null, "\t")}\n`);
	return lock;
}

/** Lists every difference between the files and the lock; empty when frozen and unchanged. */
export function verifyLock(root = FROZEN_ROOT): string[] {
	let lock: FrozenLock;
	try {
		lock = lockSchema.parse(JSON.parse(readFileSync(join(root, LOCK), "utf8")));
	} catch {
		return ["lock_missing_or_invalid"];
	}
	const actual = digests(root);
	const issues: string[] = [];
	for (const [path, digest] of Object.entries(actual)) {
		if (!(path in lock.files)) issues.push(`unlocked_file ${path}`);
		else if (lock.files[path] !== digest)
			issues.push(`digest_mismatch ${path}`);
	}
	for (const path of Object.keys(lock.files))
		if (!(path in actual)) issues.push(`missing_file ${path}`);
	return issues;
}

export type FrozenSet = {
	cases: Map<string, CaseDef>;
	criteria: Map<string, Criteria>;
	fixtures: Map<string, FixtureDef>;
	pilot: PilotPlan;
	digests: Record<string, string>;
};
const read = (root: string, path: string): unknown =>
	JSON.parse(readFileSync(join(root, path), "utf8"));

/** Parses every frozen file and checks the references between them; returns all problems. */
export function loadFrozen(root = FROZEN_ROOT): {
	set: FrozenSet | null;
	issues: string[];
} {
	const issues = verifyLock(root);
	const cases = new Map<string, CaseDef>();
	const criteria = new Map<string, Criteria>();
	const fixtures = new Map<string, FixtureDef>();
	let pilot: PilotPlan | null = null;
	const parse = <T>(path: string, schema: z.ZodType<T>): T | null => {
		try {
			const result = schema.safeParse(read(root, path));
			if (result.success) return result.data;
			const first = result.error.issues[0];
			issues.push(
				`invalid_file ${path} ${first?.path.join(".")} ${first?.message}`,
			);
		} catch {
			issues.push(`unreadable_file ${path}`);
		}
		return null;
	};
	for (const path of frozenFiles(root)) {
		if (path === PILOT) pilot = parse<PilotPlan>(path, pilotSchema);
		else if (path.startsWith("cases/")) {
			const value = parse<CaseDef>(path, caseSchema);
			if (value) cases.set(value.caseId, value);
		} else if (path.startsWith("criteria/")) {
			const value = parse<Criteria>(path, criteriaSchema);
			if (value)
				criteria.set(`criteria:${value.criteriaId}@${value.version}`, value);
		} else {
			const value = parse<FixtureDef>(path, fixtureSchema);
			if (value)
				fixtures.set(`fixture:${value.fixtureId}@${value.version}`, value);
		}
	}
	for (const c of cases.values()) {
		const criteriaDef = criteria.get(c.criteriaRef);
		if (!criteriaDef)
			issues.push(`unknown_criteria ${c.caseId} ${c.criteriaRef}`);
		else {
			if (criteriaDef.caseId !== c.caseId)
				issues.push(`criteria_case_mismatch ${c.caseId}`);
			for (const problem of validateCriteriaItems(criteriaDef))
				issues.push(`criteria_${c.caseId} ${problem}`);
		}
		const fixture = fixtures.get(c.initialStateRef);
		if (!fixture)
			issues.push(`unknown_fixture ${c.caseId} ${c.initialStateRef}`);
		else if ((fixture.stack === "product") !== c.requires.productLlm)
			issues.push(`stack_requirement_mismatch ${c.caseId}`);
	}
	if (pilot && !cases.has(pilot.caseId))
		issues.push(`unknown_pilot_case ${pilot.caseId}`);
	if (!pilot) return { set: null, issues };
	return {
		set: { cases, criteria, fixtures, pilot, digests: digests(root) },
		issues,
	};
}
