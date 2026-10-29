import {
	intentLabels,
	intentQuestion,
	type IntentInput,
	type IntentJudgment,
	type IntentLabel,
} from "../contracts/user-intent";
import { readJson } from "./guards";
import type { Provider } from "./profiles";

/** The judge's state takes these two fields only: the newest utterance, and the agent's utterance before it. */
export function intentBody(model: string, input: IntentInput) {
	return {
		model,
		state: {
			...(input.previousAgent ? { previous_agent: input.previousAgent } : {}),
			text: input.text,
		},
		questions: { intent: intentQuestion },
	};
}

/** An object field of the answer, or an empty one: optional fields may be absent. */
const object = (value: unknown): Record<string, unknown> =>
	value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
const count = (value: unknown) =>
	Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0;

/** The judge's answer, checked: one of the five labels and a score for each; anything else is an invalid answer. */
export function readIntentAnswer(body: unknown, model: string): IntentJudgment {
	const answer = object(body);
	// LARM may name the model by its long compatible name; a judge of the other use is refused by LARM itself (400).
	const answered =
		typeof answer.model === "string" && answer.model
			? answer.model.slice(0, 200)
			: model;
	const intent = object(object(answer.answers).intent);
	const choice = intent.choice;
	const scores = object(intent.probabilities);
	if (!intentLabels.includes(choice as IntentLabel))
		throw new Error("larm_invalid_intent_response");
	const probabilities = Object.fromEntries(
		intentLabels.map((label) => {
			const score = scores[label];
			if (
				typeof score !== "number" ||
				!Number.isFinite(score) ||
				score < 0 ||
				score > 1
			)
				throw new Error("larm_invalid_intent_response");
			return [label, score];
		}),
	) as Record<IntentLabel, number>;
	const head = object(answer.routing).head_revision;
	return {
		choice: choice as IntentLabel,
		probabilities,
		model: answered,
		headRevision: typeof head === "string" && head ? head.slice(0, 200) : null,
		truncated: answer.truncated === true,
		historyTokensDropped: count(answer.history_tokens_dropped),
		stateTokensDropped: count(answer.state_tokens_dropped),
	};
}

/** One judgement on the claimed decision provider of an intent port, with that claim's model and credential. */
export async function requestIntent(
	p: Provider,
	input: IntentInput,
	signal: AbortSignal,
	send: (init: RequestInit) => Promise<Response>,
): Promise<IntentJudgment> {
	const response = await send({
		method: "POST",
		headers: {
			"content-type": "application/json",
			accept: "application/json",
		},
		body: JSON.stringify(intentBody(p.model, input)),
	});
	const body = await readJson(response);
	signal.throwIfAborted();
	return readIntentAnswer(body, p.model);
}
