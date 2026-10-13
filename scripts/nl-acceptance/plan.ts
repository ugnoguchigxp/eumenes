import type { FrozenSet } from "./frozen";
import { GROUPS, type Budget, type Group } from "./types";

export type PlanEntry = {
	caseId: string;
	group: Group;
	runIndex: number;
	/** Where the target comes from. */
	target: "external-baseline" | "isolated-fixture" | "isolated-product";
	requiresProductLlm: boolean;
	budget: Budget;
};
export type Plan = {
	entries: PlanEntry[];
	issues: string[];
	/** Things a real run would refuse, shown but not fatal in a dry run. */
	warnings: string[];
	maxCostUSD: number;
	totalCapUSD: number | null;
};

export type PlanRequest = {
	pilot: boolean;
	caseId?: string;
	group?: string;
	runs?: number;
	baselineUrl?: string;
	withProductLlm: boolean;
	dryRun: boolean;
};

/** Expands the request into runs, listing every reason it cannot be launched. */
export function buildPlan(frozen: FrozenSet, request: PlanRequest): Plan {
	const issues: string[] = [];
	const warnings: string[] = [];
	const caseId = request.pilot ? frozen.pilot.caseId : request.caseId;
	const caseDef = caseId ? frozen.cases.get(caseId) : undefined;
	if (!caseDef) {
		issues.push(caseId ? `unknown_case ${caseId}` : "case_required");
		return { entries: [], issues, warnings, maxCostUSD: 0, totalCapUSD: null };
	}
	let groups: Group[];
	let runs: number;
	if (request.pilot) {
		groups = [...frozen.pilot.groups];
		runs = frozen.pilot.runsPerGroup;
		if (request.group || request.runs)
			issues.push("pilot_plan_is_fixed (--group/--runs は指定できない)");
	} else {
		const group = request.group as Group | undefined;
		if (group && !GROUPS.includes(group))
			issues.push(`unknown_group one of ${GROUPS.join("|")}`);
		else if (!group && !request.dryRun)
			issues.push(`group_required one of ${GROUPS.join("|")}`);
		groups = group ? (GROUPS.includes(group) ? [group] : []) : [...GROUPS];
		runs = request.runs ?? 1;
		if (!Number.isInteger(runs) || runs < 1 || runs > 10)
			issues.push("runs_out_of_range");
	}
	const refuse = request.dryRun ? warnings : issues;
	if (caseDef.requires.productLlm && !request.withProductLlm)
		refuse.push(`requires_with_product_llm ${caseDef.caseId}`);
	if (groups.includes("baseline") && !request.baselineUrl)
		refuse.push("baseline_url_required");
	const fixture = frozen.fixtures.get(caseDef.initialStateRef);
	const entries: PlanEntry[] = [];
	for (const group of groups)
		for (let runIndex = 1; runIndex <= runs; runIndex++)
			entries.push({
				caseId: caseDef.caseId,
				group,
				runIndex,
				target:
					group === "baseline"
						? "external-baseline"
						: fixture?.stack === "product"
							? "isolated-product"
							: "isolated-fixture",
				requiresProductLlm: caseDef.requires.productLlm,
				budget: caseDef.budget,
			});
	const maxCostUSD = entries.reduce((sum, e) => sum + e.budget.maxCostUSD, 0);
	const totalCapUSD = request.pilot ? frozen.pilot.totalCapUSD : null;
	if (totalCapUSD !== null && maxCostUSD > totalCapUSD)
		issues.push(`plan_exceeds_total_cap ${maxCostUSD} > ${totalCapUSD}`);
	return { entries, issues, warnings, maxCostUSD, totalCapUSD };
}

export type GroupTally = Record<
	Group,
	{ success: number; failure: number; inconclusive: number; planned: number }
>;
export function tally(
	plan: PlanEntry[],
	outcomes: Array<{
		group: Group;
		verdict: "success" | "failure" | "inconclusive";
	}>,
): GroupTally {
	const empty = () => ({ success: 0, failure: 0, inconclusive: 0, planned: 0 });
	const result = Object.fromEntries(
		GROUPS.map((g) => [g, empty()]),
	) as GroupTally;
	for (const e of plan) result[e.group].planned++;
	for (const o of outcomes) result[o.group][o.verdict]++;
	return result;
}

/** The pilot gate (§13): every group in the plan must be fully successful. Not a statistical claim. */
export function pilotComplete(counts: GroupTally): boolean {
	return GROUPS.every(
		(g) => counts[g].planned === 0 || counts[g].success === counts[g].planned,
	);
}
