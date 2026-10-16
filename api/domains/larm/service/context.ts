import type { LarmPort } from "../contracts";
import type { Provider } from "./profiles";

type Messages = Parameters<LarmPort["answer"]>[0];

/**
 * Drops the oldest turns until the request fits the model. The leading system run (policy, memory and reference blocks) and the last message are never dropped.
 * `bytes` is the serialized size of the returned messages, measured by the final fit check, so callers need not serialize them again.
 */
export function fitContext(
	messages: Messages,
	window: NonNullable<Provider["contextWindow"]>,
	exact = false,
): { messages: Messages; bytes: number } {
	const budget =
		window.maxTokens - window.outputReserveTokens - window.safetyMarginTokens;
	if (budget <= 0) throw new Error("larm_invalid_context_window");
	const selected = [...messages];
	const estimate = (items: Messages) =>
		new TextEncoder().encode(JSON.stringify(items)).length;
	let kept = 0;
	while (kept < selected.length && selected[kept]?.role === "system") kept++;
	let bytes = estimate(selected);
	while (!exact && selected.length - kept > 1 && bytes > budget) {
		selected.splice(kept, Math.min(2, selected.length - kept - 1));
		bytes = estimate(selected);
	}
	if (bytes > budget) throw new Error("context_window_exceeded");
	return { messages: selected, bytes };
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

const attitudeLabels = [
	"none",
	"warmth",
	"joy",
	"empathy",
	"curiosity",
	"surprise",
];
/** The system-one classifier answers a fixed label set; any other question shape is a caller bug. */
export function assertAttitudeQuestions(
	questions: Record<string, { type: string; criteria: Record<string, string> }>,
) {
	const entries = Object.values(questions);
	if (
		!entries.length ||
		entries.some(
			(q) =>
				q.type !== "choice" ||
				!Object.hasOwn(q.criteria, "none") ||
				Object.keys(q.criteria).some(
					(label) => !attitudeLabels.includes(label),
				),
		)
	)
		throw new Error("larm_invalid_attitude_question");
}
