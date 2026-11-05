import { z } from "zod";
import type { parseStep } from "eumenes-interact";
import type { InteractMemory, InteractInference } from "../contracts/interact";
import type { InteractStepInput, InteractStepResult } from "./interact-step";
const ended = (
	status: "failed" | "partial",
	code: string,
): InteractStepResult => ({ kind: "end", status, code });
const verdict = z.strictObject({
	outcome: z.enum(["achieved", "partial", "unmet"]),
	explanation: z.string().min(1).max(1000),
});
export async function reviewInteractFinish(
	input: InteractStepInput,
	mem: InteractMemory,
	signal: AbortSignal,
	step: Extract<ReturnType<typeof parseStep>["step"], { kind: "finish" }>,
	infer: (
		input: InteractStepInput,
		mem: InteractMemory,
		signal: AbortSignal,
		prepared: Parameters<InteractInference>[0]["prepared"],
		purpose: "completion_review",
	) => Promise<string>,
	reviewInstructions: string,
): Promise<InteractStepResult> {
	if (step.outcome !== "achieved")
		return {
			kind: "end",
			status: step.outcome === "partial" ? "partial" : "failed",
			code: `goal_${step.outcome}`,
			text: step.text,
		};
	if (
		step.basis !== "observed" ||
		step.refs.length === 0 ||
		step.refs.some((id) => mem.results.get(id)?.status !== "completed")
	)
		return ended("failed", "completion_evidence_invalid");
	const data = JSON.stringify({
		request: mem.request,
		task: mem.brief ?? mem.request,
		proposedAnswer: step.text,
		evidence: step.refs,
		results: [...mem.results.values()],
	});
	if (data.length > 200000)
		return ended("partial", "completion_review_unavailable");
	let checked: z.infer<typeof verdict>;
	try {
		checked = verdict.parse(
			JSON.parse(
				await infer(
					input,
					mem,
					signal,
					{
						messages: [
							{ role: "system", content: reviewInstructions },
							{ role: "user", content: data },
						],
						callsLeft: 1,
						outputSchema: z.toJSONSchema(verdict),
					},
					"completion_review",
				),
			),
		);
	} catch {
		return ended("partial", "completion_review_unavailable");
	}
	return checked.outcome === "achieved"
		? {
				kind: "end",
				status: "completed",
				code: "goal_achieved",
				text: step.text,
			}
		: {
				kind: "end",
				status: "partial",
				code: "completion_review_partial",
				text: checked.explanation,
			};
}
