import { afterAll, describe, expect, test } from "bun:test";
import {
	cpSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	FROZEN_ROOT,
	freeze,
	loadFrozen,
	verifyLock,
} from "../../../scripts/nl-acceptance/frozen";
import { buildPlan } from "../../../scripts/nl-acceptance/plan";

const dirs: string[] = [];
function copy(): string {
	const dir = mkdtempSync(join(tmpdir(), "nl-frozen-"));
	dirs.push(dir);
	cpSync(FROZEN_ROOT, dir, { recursive: true });
	return dir;
}
afterAll(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("the committed frozen set", () => {
	test("matches its lock, parses, and every reference resolves", () => {
		const { set, issues } = loadFrozen();
		expect(issues).toEqual([]);
		expect([...set!.cases.keys()].sort()).toEqual([
			"timer-conversation-cancel-01",
			"timer-conversation-start-01",
			"timer-expiry-01",
			"timer-invalid-input-01",
			"timer-network-loss-01",
			"timer-question-continuation-01",
			"timer-rediscovery-01",
			"timer-ui-purpose-01",
		]);
	});

	test("the main case and the pilot follow the design", () => {
		const { set } = loadFrozen();
		const main = set!.cases.get("timer-ui-purpose-01")!;
		expect(main.budget).toEqual({
			wallSeconds: 300,
			maxActions: 40,
			maxModelCalls: 30,
			maxCostUSD: 2,
		});
		expect(set!.criteria.get(main.criteriaRef)!.items.map((i) => i.id)).toEqual(
			["C1", "C2", "C3", "C4", "C5"],
		);
		expect(set!.pilot).toMatchObject({
			groups: ["baseline", "standard", "variant-a", "variant-b"],
			runsPerGroup: 3,
			totalCapUSD: 30,
			autoRepeatUntilPass: false,
		});
	});

	test("cases carry a goal and budget only: no selector, step or click sequence", () => {
		const { set } = loadFrozen();
		for (const c of set!.cases.values()) {
			const text = readFileSync(
				join(FROZEN_ROOT, "cases", `${c.caseId}.json`),
				"utf8",
			);
			expect(Object.keys(JSON.parse(text)).sort()).toEqual([
				"allowedSurface",
				"budget",
				"caseId",
				"criteriaRef",
				"evidence",
				"goal",
				"initialStateRef",
				"requires",
				"version",
			]);
			expect(text).not.toMatch(/selector|xpath|locator|getBy|querySelector/i);
		}
	});

	test("conversation cases need --with-product-llm, UI-only cases do not", () => {
		const { set } = loadFrozen();
		const needs = [...set!.cases.values()]
			.filter((c) => c.requires.productLlm)
			.map((c) => c.caseId)
			.sort();
		expect(needs).toEqual([
			"timer-conversation-cancel-01",
			"timer-conversation-start-01",
			"timer-question-continuation-01",
		]);
	});
});

describe("the lock refuses a changed or unlocked set", () => {
	test("a changed criteria file is a digest mismatch and is reported by loadFrozen", () => {
		const dir = copy();
		const path = join(dir, "criteria", "timer-ui-purpose-01.json");
		writeFileSync(
			path,
			readFileSync(path, "utf8").replace(
				'"toleranceSeconds": 2',
				'"toleranceSeconds": 9',
			),
		);
		expect(verifyLock(dir)).toEqual([
			"digest_mismatch criteria/timer-ui-purpose-01.json",
		]);
		const { issues } = loadFrozen(dir);
		expect(issues).toContain(
			"digest_mismatch criteria/timer-ui-purpose-01.json",
		);
	});

	test("a changed case, fixture or pilot file is refused", () => {
		const dir = copy();
		for (const file of [
			"cases/timer-ui-purpose-01.json",
			"fixtures/empty-timers.json",
			"pilot.json",
		]) {
			const path = join(dir, file);
			writeFileSync(path, `${readFileSync(path, "utf8")}\n `);
		}
		expect(verifyLock(dir).sort()).toEqual([
			"digest_mismatch cases/timer-ui-purpose-01.json",
			"digest_mismatch fixtures/empty-timers.json",
			"digest_mismatch pilot.json",
		]);
	});

	test("an added file is unlocked and a deleted file is missing", () => {
		const dir = copy();
		writeFileSync(join(dir, "cases", "extra.json"), "{}");
		rmSync(join(dir, "fixtures", "one-active-timer.json"));
		expect(verifyLock(dir).sort()).toEqual([
			"missing_file fixtures/one-active-timer.json",
			"unlocked_file cases/extra.json",
		]);
	});

	test("a missing lock refuses everything", () => {
		const dir = copy();
		rmSync(join(dir, "frozen.lock.json"));
		expect(verifyLock(dir)).toEqual(["lock_missing_or_invalid"]);
	});

	test("freezing a procedural goal is caught by the schema, not by the lock", () => {
		const dir = copy();
		const path = join(dir, "cases", "timer-ui-purpose-01.json");
		const c = JSON.parse(readFileSync(path, "utf8"));
		c.goal = "getByRole('button') をクリックして3分にする";
		writeFileSync(path, JSON.stringify(c));
		freeze(dir);
		const { issues } = loadFrozen(dir);
		expect(
			issues.some((i) =>
				i.startsWith("invalid_file cases/timer-ui-purpose-01.json"),
			),
		).toBe(true);
	});

	test("an unknown check in the criteria is reported before any run", () => {
		const dir = copy();
		const path = join(dir, "criteria", "timer-ui-purpose-01.json");
		writeFileSync(
			path,
			readFileSync(path, "utf8").replace('"new-timers"', '"made-up-check"'),
		);
		freeze(dir);
		expect(
			loadFrozen(dir).issues.some((i) =>
				i.includes("unknown_check made-up-check"),
			),
		).toBe(true);
	});
});

describe("plans", () => {
	const { set } = loadFrozen();
	const base = { pilot: false, withProductLlm: false, dryRun: false };

	test("the pilot is 4 groups x 3 runs within the 30 USD cap", () => {
		const plan = buildPlan(set!, {
			...base,
			pilot: true,
			baselineUrl: "http://baseline.test",
		});
		expect(plan.issues).toEqual([]);
		expect(plan.entries).toHaveLength(12);
		expect(plan.maxCostUSD).toBe(24);
	});

	test("a real run needs a group, a baseline URL for baseline, and the flag for conversation cases", () => {
		expect(
			buildPlan(set!, { ...base, caseId: "timer-ui-purpose-01" }).issues[0],
		).toContain("group_required");
		expect(
			buildPlan(set!, {
				...base,
				caseId: "timer-ui-purpose-01",
				group: "baseline",
			}).issues,
		).toContain("baseline_url_required");
		expect(
			buildPlan(set!, {
				...base,
				caseId: "timer-conversation-start-01",
				group: "standard",
			}).issues[0],
		).toContain("requires_with_product_llm");
		expect(
			buildPlan(set!, {
				...base,
				caseId: "timer-conversation-start-01",
				group: "standard",
				withProductLlm: true,
			}).issues,
		).toEqual([]);
	});

	test("a dry run lists every group and only warns", () => {
		const plan = buildPlan(set!, {
			...base,
			dryRun: true,
			caseId: "timer-ui-purpose-01",
		});
		expect(plan.issues).toEqual([]);
		expect(plan.entries).toHaveLength(4);
		expect(plan.warnings).toContain("baseline_url_required");
	});

	test("the pilot plan cannot be reshaped from the command line", () => {
		expect(
			buildPlan(set!, {
				...base,
				pilot: true,
				group: "standard",
				baselineUrl: "x",
			}).issues[0],
		).toContain("pilot_plan_is_fixed");
	});
});
