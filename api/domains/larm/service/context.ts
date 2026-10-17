import {
	exchangeEnd,
	estimateMessageTokens,
} from "../../../infrastructure/context-budget";
import { getLogger } from "../../../infrastructure/logger";
import type { LarmPort } from "../contracts";
import type { Provider } from "./profiles";

type Messages = Parameters<LarmPort["answer"]>[0];
const log = getLogger("larm");

/** Where the adopted history sits in a host-fixed list: after `instructionCount` messages, `historyCount` of them. */
type HistoryRange = { instructionCount: number; historyCount: number };

/**
 * Fits the request to the model window, by the token estimate (never the byte size).
 *
 * - A request the server may trim drops the oldest turns until it fits; the leading system run and the last
 *   message are never dropped, and a request that still does not fit is `context_window_exceeded`.
 * - An `exact` request was fitted by the host to its budgets. The estimate is not exact, so a list that is still
 *   over the window is not an error: the oldest adopted history turns go (never the system part, the data of the
 *   turn or the request), the dropped count is logged, and a list that still does not fit is sent as it is for the
 *   provider to judge. `history` says where the turns are; without it nothing can be dropped safely.
 *
 * `bytes` is the serialized size of the returned messages (for the timing log); `history` the range after dropping.
 */
export function fitContext(
	messages: Messages,
	window: NonNullable<Provider["contextWindow"]>,
	exact = false,
	history?: HistoryRange,
): { messages: Messages; bytes: number; history?: HistoryRange } {
	const budget =
		window.maxTokens - window.outputReserveTokens - window.safetyMarginTokens;
	if (budget <= 0) throw new Error("larm_invalid_context_window");
	const selected = [...messages];
	const sizes = selected.map((message) => estimateMessageTokens([message]));
	const total = () => sizes.reduce((sum, size) => sum + size, 0);
	let tokens = total();
	let range = history ? { ...history } : undefined;
	if (!exact) {
		let kept = 0;
		while (kept < selected.length && selected[kept]?.role === "system") kept++;
		while (selected.length - kept > 1 && tokens > budget) {
			// Whole exchanges go, the oldest first; the leading system run and the last message stay.
			const roles = selected.slice(kept, -1).map((m) => m.role);
			const count = exchangeEnd(roles, 0, roles.length);
			selected.splice(kept, count);
			tokens -= sizes.splice(kept, count).reduce((sum, size) => sum + size, 0);
		}
		if (tokens > budget) throw new Error("context_window_exceeded");
	} else if (tokens > budget) {
		// The adopted history is the first `historyCount` user/assistant messages after the instructions (system
		// messages between them, such as the working memory, are not history).
		const at: number[] = [];
		for (
			let i = range?.instructionCount ?? 0;
			range && i < selected.length && at.length < range.historyCount;
			i++
		)
			if (selected[i]!.role !== "system") at.push(i);
		let dropped = 0;
		const gone = new Set<number>();
		const roles = at.map((i) => selected[i]!.role);
		while (tokens > budget && dropped < at.length) {
			// Whole exchanges go, the oldest first, so the history never starts with an assistant message.
			for (const i of at.slice(
				dropped,
				exchangeEnd(roles, dropped, at.length),
			)) {
				gone.add(i);
				tokens -= sizes[i]!;
				dropped++;
			}
		}
		if (dropped > 0) {
			for (let i = selected.length - 1; i >= 0; i--)
				if (gone.has(i)) selected.splice(i, 1);
			range = { ...range!, historyCount: range!.historyCount - dropped };
		}
		log.warn("larm.exact_context_over_window", {
			droppedMessages: dropped,
			promptTokens: tokens,
			limit: budget,
			reason: tokens > budget ? "still_over" : "history_dropped",
		});
	}
	return {
		messages: selected,
		bytes: new TextEncoder().encode(JSON.stringify(selected)).length,
		...(range ? { history: range } : {}),
	};
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
