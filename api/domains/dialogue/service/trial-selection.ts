import { systemContext } from "../../../infrastructure/system-context";
import type { ToolchainCard } from "../../capabilities";
import type { InferencePort } from "../../inference";
import { analysisTools, validateAnalysis } from "./initial-decision";

/**
 * The first round on one utterance as a trial (spec task-pipeline-design 2026-10-22 §8.2 選択の試験): the same
 * functions and instruction the conversation offers for these candidates, with no history, and nothing run. Says
 * which function was called and, for a pipeline or an instant toolchain, with which inputs.
 */
export async function trialFirstRound(
	larm: Pick<InferencePort, "executeStream">,
	input: {
		requestId: string;
		text: string;
		cards: readonly ToolchainCard[];
		signal: AbortSignal;
	},
): Promise<{
	chosen: string | null;
	next: string | null;
	inputs: Record<string, unknown> | null;
	code: string | null;
}> {
	if (!larm.executeStream) throw new Error("inference_unavailable");
	const tools = analysisTools(input.cards);
	const receipt = await larm.executeStream(
		input.requestId,
		[
			{
				role: "system",
				content: systemContext(
					"dialogue.contexts.request-analysis.instruction",
					{},
				),
			},
			{ role: "user", content: input.text },
		],
		input.signal,
		() => {},
		undefined,
		tools,
		{ sessionRole: "auxiliary", toolChoice: "required", outputLimit: 1024 },
	);
	const calls = receipt.toolCalls ?? [];
	const chosen = calls[0]?.name ?? null;
	try {
		const round = validateAnalysis(
			calls,
			input.cards,
			false,
			undefined,
			undefined,
			input.text,
		);
		return {
			chosen,
			next: round.next,
			inputs:
				round.next === "pipeline"
					? round.inputs
					: round.next === "instant"
						? round.arguments
						: null,
			code: null,
		};
	} catch (error) {
		return {
			chosen,
			next: null,
			inputs: null,
			code: error instanceof Error ? error.message : "analysis_invalid",
		};
	}
}
