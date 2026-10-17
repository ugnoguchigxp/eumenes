/** Per-trial scoring, adjudication overrides and the per-case majority verdict (spec 5.4, 5.6). */
import { z } from "zod";
import {
	type ContextCase,
	FAMILIES,
	type Family,
	RUBRIC_AXES,
	SPLITS,
} from "./case-schema";
import { type CheckResult, runChecks } from "./checks";
import { type AxisResult, type JudgeFn, judgeAnswer } from "./judge";
import type { RawRow } from "./raw";

export const adjudicationSchema = z
	.object({
		version: z.literal(1),
		entries: z.array(
			z
				.object({
					caseId: z.string().min(1),
					arm: z.string().min(1),
					trial: z.number().int().min(1),
					axis: z.enum(RUBRIC_AXES),
					pass: z.union([z.literal(0), z.literal(1)]),
					reason: z.string().min(1),
				})
				.strict(),
		),
	})
	.strict();
export type Adjudication = z.infer<typeof adjudicationSchema>;
export const noAdjudication: Adjudication = { version: 1, entries: [] };

export type TrialScore = {
	arm: string;
	caseId: string;
	family: Family;
	split: ContextCase["split"];
	trial: number;
	status: "scored" | "transport_error" | "needs_adjudication";
	checks: CheckResult[];
	axes: AxisResult[];
	/** null when the trial is incomplete (transport error or an axis awaiting adjudication). */
	pass: boolean | null;
	/** The reply broke the spoken-reply contract, needed the correction, or failed generation. */
	contractViolation: boolean;
	promptTokens: number;
	latencyMs: number;
	/** The judge or the user decided at least one axis of this trial by adjudication. */
	adjudicated: boolean;
};

/** An adjudication settles only an axis the judge left unresolved; a clean verdict is never overridden. */
function applyAdjudication(
	axes: AxisResult[],
	row: Pick<RawRow, "arm" | "caseId" | "trial">,
	adjudication: Adjudication,
): { axes: AxisResult[]; used: boolean } {
	let used = false;
	const settled = axes.map((axis): AxisResult => {
		if (axis.status !== "needs_adjudication") return axis;
		const entry = adjudication.entries.find(
			(e) =>
				e.caseId === row.caseId &&
				e.arm === row.arm &&
				e.trial === row.trial &&
				e.axis === axis.axis,
		);
		if (!entry) return axis;
		used = true;
		return {
			axis: axis.axis,
			status: "judged",
			pass: entry.pass,
			reason: `adjudicated: ${entry.reason}`,
		};
	});
	return { axes: settled, used };
}

export async function scoreTrial(input: {
	row: RawRow;
	case: ContextCase;
	judge: JudgeFn;
	rules: string;
	adjudication?: Adjudication;
}): Promise<TrialScore> {
	const { row } = input;
	const common = {
		arm: row.arm,
		caseId: row.caseId,
		family: input.case.family,
		split: input.case.split,
		trial: row.trial,
		promptTokens: row.promptTokensEstimate,
		latencyMs: row.latencyMs,
	};
	if (row.status === "transport_error" || (row.status === "ok" && !row.answer))
		return {
			...common,
			status: "transport_error",
			checks: [],
			axes: [],
			pass: null,
			contractViolation: false,
			adjudicated: false,
		};
	if (row.status === "contract_failure")
		return {
			...common,
			status: "scored",
			checks: [
				{
					kind: "generation_contract",
					pass: false,
					reason: row.errorCode ?? "contract_failure",
				},
			],
			axes: [],
			pass: false,
			contractViolation: true,
			adjudicated: false,
		};
	const answer = row.answer!;
	const checks = runChecks(input.case.expect.checks, answer);
	const judged = await judgeAnswer({
		case: input.case,
		answer,
		rules: input.rules,
		judge: input.judge,
	});
	const { axes, used } = applyAdjudication(
		judged,
		row,
		input.adjudication ?? noAdjudication,
	);
	const unresolved = axes.some((a) => a.status === "needs_adjudication");
	// A failed deterministic check is final: an unresolved judge cannot turn it into "incomplete".
	const checksFailed = checks.some((c) => !c.pass);
	const pass = checksFailed
		? false
		: unresolved
			? null
			: axes.every((a) => a.pass === 1);
	return {
		...common,
		status: unresolved && !checksFailed ? "needs_adjudication" : "scored",
		checks,
		axes,
		pass,
		contractViolation:
			row.repaired ||
			checks.some((c) => c.kind === "brief_spoken_reply" && !c.pass),
		adjudicated: used,
	};
}

export type CaseVerdict = {
	arm: string;
	caseId: string;
	family: Family;
	split: ContextCase["split"];
	expectedTrials: number;
	passes: number;
	transportErrors: number;
	needsAdjudication: number;
	missingTrials: number;
	/** Rows beyond one per trial, or with a trial number outside 1..expectedTrials. They never add to `passes`. */
	invalidRows: number;
	/** Any trial is unresolved, failed to run, or missing, or the rows are inconsistent. */
	incomplete: boolean;
	/** Majority of the expected trials passed; null when incomplete. */
	pass: boolean | null;
};

/** Majority of the expected trials; incomplete when any trial is unresolved or missing, or the rows are inconsistent. */
export function caseVerdicts(
	scores: readonly TrialScore[],
	cases: readonly ContextCase[],
	arms: readonly string[],
	expectedTrials: number,
): CaseVerdict[] {
	const verdicts: CaseVerdict[] = [];
	for (const arm of arms)
		for (const testCase of cases) {
			const own = scores.filter(
				(s) => s.arm === arm && s.caseId === testCase.id,
			);
			// One row per trial number inside the range counts; anything else is an inconsistency, never a vote.
			const counted = new Map<number, TrialScore>();
			let invalidRows = 0;
			for (const s of own) {
				if (
					!Number.isInteger(s.trial) ||
					s.trial < 1 ||
					s.trial > expectedTrials ||
					counted.has(s.trial)
				)
					invalidRows++;
				else counted.set(s.trial, s);
			}
			const unique = [...counted.values()];
			const passes = unique.filter((s) => s.pass === true).length;
			const transportErrors = unique.filter(
				(s) => s.status === "transport_error",
			).length;
			const needsAdjudication = unique.filter(
				(s) => s.status === "needs_adjudication",
			).length;
			const missingTrials = expectedTrials - unique.length;
			const incomplete =
				transportErrors > 0 ||
				needsAdjudication > 0 ||
				missingTrials > 0 ||
				invalidRows > 0;
			verdicts.push({
				arm,
				caseId: testCase.id,
				family: testCase.family,
				split: testCase.split,
				expectedTrials,
				passes,
				transportErrors,
				needsAdjudication,
				missingTrials,
				invalidRows,
				incomplete,
				pass: incomplete ? null : passes * 2 > expectedTrials,
			});
		}
	return verdicts;
}

const checkResultSchema = z
	.object({
		kind: z.enum([
			"tool_called",
			"no_tool_call",
			"brief_spoken_reply",
			"forbidden_identifier",
			"generation_contract",
		]),
		pass: z.boolean(),
		reason: z.string(),
	})
	.strict();
const axisResultSchema = z.discriminatedUnion("status", [
	z
		.object({
			axis: z.enum(RUBRIC_AXES),
			status: z.literal("judged"),
			pass: z.union([z.literal(0), z.literal(1)]),
			reason: z.string(),
		})
		.strict(),
	z
		.object({
			axis: z.enum(RUBRIC_AXES),
			status: z.literal("needs_adjudication"),
			pass: z.null(),
			reason: z.string(),
		})
		.strict(),
]);
/** A line of scores.jsonl. `analyze` refuses anything that does not parse. */
export const trialScoreSchema = z
	.object({
		arm: z.string().min(1),
		caseId: z.string().min(1),
		family: z.enum(FAMILIES),
		split: z.enum(SPLITS),
		trial: z.number().int().min(1),
		status: z.enum(["scored", "transport_error", "needs_adjudication"]),
		checks: z.array(checkResultSchema),
		axes: z.array(axisResultSchema),
		pass: z.boolean().nullable(),
		contractViolation: z.boolean(),
		promptTokens: z.number().min(0),
		latencyMs: z.number().min(0),
		adjudicated: z.boolean(),
	})
	.strict();
