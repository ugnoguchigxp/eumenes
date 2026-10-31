import { withLogContext } from "../../../infrastructure/logger";
import type { ToolchainCard } from "../../capabilities";
import type { InferencePort } from "../../inference";
import type { RoutedInput } from "./context";
import { personaStyle } from "./context-system";
import { candidateOf } from "./executor-context";
import { jstNowLine } from "./input-text";
import { choiceMessages, choiceSchema, parseChoice } from "./routed-choice";
import { stateText } from "./state-text";

/** A conversation with nothing in it: no memory, no earlier words, no work, nothing presented or pending. */
const emptyRouted = (): RoutedInput => ({
	memory: null,
	earlier: [],
	state: stateText([`今: ${jstNowLine(Date.now())}`]),
	previousReply: null,
	asked: null,
	pending: { confirmations: [], questions: [] },
	todos: [],
	resources: [],
	switching: null,
});

/**
 * The conversation's choice on one utterance as a trial (spec task-pipeline-design 2026-10-22 §8.2 選択の試験): the
 * request turn's one choice as the product makes it (its input and schema, the single harness plan), on an empty
 * conversation, with the candidates given as the host's search found them. Nothing is run. Says which toolchain's
 * function the model chose and, for a pipeline or an instant toolchain, with which inputs.
 */
export async function trialFirstRound(
	inference: Pick<InferencePort, "executeControl">,
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
	const control = inference.executeControl?.bind(inference);
	if (!control) throw new Error("inference_unavailable");
	const routed = emptyRouted();
	const candidates = input.cards.map((card) => candidateOf(card, null));
	const receipt = await withLogContext({ phase: "trial_decision" }, () =>
		control(
			input.requestId,
			choiceMessages({
				// The say a choice writes is not read here: any persona's style serves.
				style: personaStyle({ agentName: "", userName: "", persona: "butler" }),
				routed,
				candidates,
				utterance: input.text,
			}),
			input.signal,
			{ instructions: "", outputSchema: choiceSchema(candidates, routed) },
		),
	);
	input.signal.throwIfAborted();
	const chosen = parseChoice(
		typeof receipt.value === "string"
			? receipt.value
			: new TextDecoder().decode(receipt.value),
	);
	if (!chosen)
		return { chosen: null, next: null, inputs: null, code: "analysis_invalid" };
	const card = input.cards.find((c) => c.id === chosen.choice);
	// No toolchain (none, a question back, a memory or work operation): the conversation answers.
	if (!card) return { chosen: null, next: "answer", inputs: null, code: null };
	const next = card.pipeline
		? "pipeline"
		: card.instant
			? "instant"
			: "toolchain";
	const raw =
		chosen.inputs && typeof chosen.inputs === "object"
			? (chosen.inputs as Record<string, unknown>)
			: {};
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
}
