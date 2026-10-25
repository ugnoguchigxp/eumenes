import { withLogContext } from "../../../infrastructure/logger";
import type { ToolchainCard } from "../../capabilities";
import type { InferencePort } from "../../inference";
import { systemText } from "./context-system";
import { candidateOf } from "./executor-context";
import { generationTools, parseCall, TOOL_NAMES } from "./generation-tools";

/**
 * The conversation's choice on one utterance as a trial (spec task-pipeline-design 2026-10-22 §8.2 選択の試験):
 * the same system and fixed tools, an empty window, and the candidates given as the result of a search the host
 * made. Nothing is run. Says which toolchain's function the model chose and, for a pipeline or an instant
 * toolchain, with which inputs.
 */
export async function trialFirstRound(
	larm: Pick<InferencePort, "executeStream">,
	input: {
		requestId: string;
		text: string;
		cards: readonly ToolchainCard[];
		/** The conversation agent's part of the system message. */
		agentSystem: string;
		signal: AbortSignal;
	},
): Promise<{
	chosen: string | null;
	next: string | null;
	inputs: Record<string, unknown> | null;
	code: string | null;
}> {
	if (!larm.executeStream) throw new Error("inference_unavailable");
	const searchId = "trial-search";
	const receipt = await withLogContext({ phase: "trial_decision" }, () =>
		larm.executeStream!(
			input.requestId,
			[
				{
					role: "system",
					content:
						input.agentSystem +
						"\n" +
						systemText({ agentName: "", userName: "", persona: "butler" }),
				},
				{ role: "user", content: input.text },
				{
					role: "assistant",
					content: "",
					tool_calls: [
						{
							id: searchId,
							type: "function",
							function: {
								name: TOOL_NAMES.search,
								arguments: JSON.stringify({ query: input.text }),
							},
						},
					],
				},
				{
					role: "tool",
					tool_call_id: searchId,
					content: JSON.stringify({
						candidates: input.cards.map((card) => candidateOf(card, null)),
					}),
				},
			],
			input.signal,
			() => {},
			undefined,
			generationTools,
			{ sessionRole: "auxiliary" },
		),
	);
	input.signal.throwIfAborted();
	try {
		const calls = (receipt.toolCalls ?? []).map(parseCall);
		const delegated = calls.find((call) => call.name === TOOL_NAMES.delegate);
		const args =
			delegated?.name === TOOL_NAMES.delegate ? delegated.args : null;
		if (!args || args.mode === "approve")
			return { chosen: null, next: "answer", inputs: null, code: null };
		const toolchainId = args.toolchain;
		const card = input.cards.find((c) => c.id === toolchainId);
		if (!card)
			return {
				chosen: null,
				next: null,
				inputs: null,
				code: "toolchain_not_offered",
			};
		const next = card.pipeline
			? "pipeline"
			: card.instant
				? "instant"
				: "toolchain";
		const raw = args.inputs ?? {};
		const parsed = card.pipeline
			? card.pipeline.parse(raw, input.text)
			: card.instant
				? card.instant.parse(raw)
				: null;
		if (parsed && !parsed.ok)
			return {
				chosen: card.functionName,
				next,
				inputs: null,
				code: "invalid_inputs",
			};
		return {
			chosen: card.functionName,
			next,
			inputs: parsed?.ok ? parsed.value : null,
			code: null,
		};
	} catch (error) {
		return {
			chosen: null,
			next: null,
			inputs: null,
			code: error instanceof Error ? error.message : "analysis_invalid",
		};
	}
}
