import type { PlanItem } from "../../domains/continuity";

export function planReferenceKind(plan: PlanItem): "conflict" | "plan" {
	return plan.kind === "open_question" && plan.memoryItemIds.length > 0
		? "conflict"
		: "plan";
}

/** The agenda uses the host's ref verbatim. Bind the visible text to the revision it described. */
export const planReference = (plan: PlanItem) => `${plan.id}@${plan.revision}`;

export const recordReferencePattern = /^(goal|plan|conflict):/u;

export function parseRecordReference(ref: string) {
	const match = /^(goal|plan|conflict):([^@]+)(?:@([1-9]\d*))?$/u.exec(ref);
	if (!match) return null;
	const kind = match[1] as "goal" | "plan" | "conflict";
	const revision = match[3] === undefined ? undefined : Number(match[3]);
	if (revision !== undefined && !Number.isSafeInteger(revision)) return null;
	return { kind, id: match[2]!, revision };
}
