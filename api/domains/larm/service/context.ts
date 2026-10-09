import type { LarmPort } from "../contracts";
import type { Provider } from "./profiles";

type Messages = Parameters<LarmPort["answer"]>[0];

/** Drops the oldest turns (keeping the first and last) until the request fits the model. */
export function fitContext(
	messages: Messages,
	window: NonNullable<Provider["contextWindow"]>,
	exact = false,
): Messages {
	const budget =
		window.maxTokens - window.outputReserveTokens - window.safetyMarginTokens;
	if (budget <= 0) throw new Error("larm_invalid_context_window");
	const selected = [...messages];
	const estimate = (items: Messages) =>
		new TextEncoder().encode(JSON.stringify(items)).length;
	while (!exact && selected.length > 2 && estimate(selected) > budget)
		selected.splice(1, Math.min(2, selected.length - 2));
	if (estimate(selected) > budget) throw new Error("context_window_exceeded");
	return selected;
}

/** An invalid optional credit never invalidates the audio it accompanies. */
export function decodeSpeechCredit(header: string | null): string | undefined {
	if (!header?.startsWith("UTF-8''")) return undefined;
	try {
		return decodeURIComponent(header.slice(7)).slice(0, 2048);
	} catch {
		return undefined;
	}
}

const ruriLabels = [
	"none",
	"warmth",
	"joy",
	"empathy",
	"curiosity",
	"surprise",
];
/** Ruri classifies a fixed label set; any other question shape is a caller bug. */
export function assertRuriQuestions(
	questions: Record<string, { type: string; criteria: Record<string, string> }>,
) {
	const entries = Object.values(questions);
	if (
		!entries.length ||
		entries.some(
			(q) =>
				q.type !== "choice" ||
				!Object.hasOwn(q.criteria, "none") ||
				Object.keys(q.criteria).some((label) => !ruriLabels.includes(label)),
		)
	)
		throw new Error("larm_invalid_ruri_question");
}
