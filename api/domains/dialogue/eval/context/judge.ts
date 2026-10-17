/**
 * Blind judge for the semantic axes (spec 5.4). The judge function is injected; this builds the request,
 * validates the reply with zod, and fails closed: anything unusable is `needs_adjudication`, never a pass or fail.
 * Modeled on scripts/search-answer-evaluation.ts (auxiliary session, exact context, JSON schema, no repair).
 * The request carries seed facts, the current input, the answer (its text and the functions it called, each with
 * its arguments) and the axes. Never the arm id nor the context text. The whole payload is escaped as reference
 * data (`referenceJson`), so nothing in an answer or in an argument can forge a delimiter.
 */
import { z } from "zod";
import { referenceJson } from "../../../inference";
import {
	type ContextCase,
	RUBRIC_AXES,
	type RubricAxis,
	type RubricAxisName,
	type Seed,
} from "./case-schema";
import type { Answer } from "./checks";

export type JudgeRequest = {
	messages: Array<{ role: "system" | "user"; content: string }>;
	options: {
		jsonOutput: true;
		jsonSchema: Record<string, unknown>;
		sessionRole: "auxiliary";
		contextPolicy: "exact";
		maxOutputTokens: number;
	};
};
/** Returns the judge's reply: the parsed value, or the raw JSON text. Throws on a transport failure. */
export type JudgeFn = (request: JudgeRequest) => Promise<unknown>;

export const verdictSchema = z
	.object({
		axes: z.array(
			z
				.object({
					axis: z.enum(RUBRIC_AXES),
					pass: z.union([z.literal(0), z.literal(1)]),
					reason: z.string().min(1).max(600),
				})
				.strict(),
		),
	})
	.strict();

export type AxisResult =
	| { axis: RubricAxisName; status: "judged"; pass: 0 | 1; reason: string }
	| {
			axis: RubricAxisName;
			status: "needs_adjudication";
			pass: null;
			reason: string;
	  };

/** The seed as the judge's source of truth, in plain labelled fields (no persona, no arm or layout detail). */
export function factsOf(seed: Seed) {
	return {
		longTermMemory: (seed.longTerm ?? []).map((i) => i.text),
		shortTermNotes: (seed.notes ?? []).map((n) => ({
			kind: n.kind,
			text: n.text,
		})),
		conversationSummary: seed.summary?.text ?? null,
		conversationExchanges: (seed.exchanges ?? []).map((e) => ({
			at: e.at,
			user: e.user,
			...(e.assistant === undefined ? {} : { assistant: e.assistant }),
		})),
		recalledExchanges: seed.recall ?? [],
		adoptedGoals: (seed.goals ?? []).map((g) => g.text),
		worldTargetNamesKnown: (seed.world ?? []).map((w) => w.name),
		notices: seed.notices ?? [],
		operationResult: seed.operation ?? null,
		research: seed.research ?? null,
		specialistRecord: seed.specialist ?? null,
	};
}

const MAX_OUTPUT_TOKENS = 1024;

export function buildJudgeRequest(
	testCase: Pick<ContextCase, "seed" | "input" | "expect">,
	answer: Answer,
	rules: string,
): JudgeRequest {
	const axes: RubricAxis[] = testCase.expect.rubric;
	return {
		messages: [
			{ role: "system", content: rules },
			{
				role: "user",
				content: referenceJson({
					facts: factsOf(testCase.seed),
					currentInput: testCase.input,
					answer: {
						text: answer.text,
						toolCalls: answer.toolCalls.map((c) => ({
							name: c.name,
							arguments: c.arguments ?? "",
						})),
					},
					axes,
				}),
			},
		],
		options: {
			jsonOutput: true,
			jsonSchema: z.toJSONSchema(verdictSchema) as Record<string, unknown>,
			sessionRole: "auxiliary",
			contextPolicy: "exact",
			maxOutputTokens: MAX_OUTPUT_TOKENS,
		},
	};
}

const unresolved = (
	axes: readonly RubricAxis[],
	reason: string,
): AxisResult[] =>
	axes.map((a) => ({
		axis: a.axis,
		status: "needs_adjudication",
		pass: null,
		reason,
	}));

/**
 * Judges the case's rubric axes for one answer. No retry, no repair, no guessed pass: a failed call, unparsable
 * JSON, a schema violation, or an axis set that differs from the requested one makes every axis needs_adjudication.
 */
export async function judgeAnswer(input: {
	case: Pick<ContextCase, "seed" | "input" | "expect">;
	answer: Answer;
	rules: string;
	judge: JudgeFn;
}): Promise<AxisResult[]> {
	const axes = input.case.expect.rubric;
	if (axes.length === 0) return [];
	let reply: unknown;
	try {
		reply = await input.judge(
			buildJudgeRequest(input.case, input.answer, input.rules),
		);
	} catch {
		return unresolved(axes, "judge_call_failed");
	}
	if (typeof reply === "string") {
		try {
			reply = JSON.parse(reply);
		} catch {
			return unresolved(axes, "judge_json_invalid");
		}
	}
	const parsed = verdictSchema.safeParse(reply);
	if (!parsed.success) return unresolved(axes, "judge_schema_invalid");
	const wanted = axes.map((a) => a.axis).sort();
	const got = parsed.data.axes.map((a) => a.axis).sort();
	if (wanted.length !== got.length || wanted.some((axis, i) => axis !== got[i]))
		return unresolved(axes, "judge_axes_mismatch");
	return axes.map((a) => {
		const result = parsed.data.axes.find((r) => r.axis === a.axis)!;
		return {
			axis: a.axis,
			status: "judged",
			pass: result.pass,
			reason: result.reason,
		};
	});
}
