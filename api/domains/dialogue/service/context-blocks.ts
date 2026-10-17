import { promptTime, type ContextBlock } from "../../inference";
import type { WindowSnapshot } from "../../memory";

/** The long-term layer, as memory structured it; null when the layer is empty. */
export function longTermBlock(window: WindowSnapshot): ContextBlock | null {
	if (!window.longTerm.text) return null;
	return {
		source: "memory.long_term",
		authority: "reference",
		freshness: "stable",
		certainty: "remembered",
		body: {
			kind: "lines",
			header: window.longTerm.header,
			sections: window.longTerm.sections,
		},
	};
}

/** The summary of the earlier exchanges, with the range it stands on; null when there is none. */
export function summaryBlock(window: WindowSnapshot): ContextBlock | null {
	if (!window.history.summaryText) return null;
	return {
		source: "memory.summary",
		authority: "reference",
		freshness: "past",
		...(window.history.summaryCovers
			? { covers: window.history.summaryCovers }
			: {}),
		body: { kind: "text", text: window.history.summaryText },
	};
}

/** The short-term notes and the recently remembered; null when there are none. */
export function shortTermBlock(window: WindowSnapshot): ContextBlock | null {
	if (!window.shortTerm.text) return null;
	return {
		source: "memory.short_term",
		authority: "reference",
		freshness: "recent",
		certainty: "remembered",
		body: {
			kind: "lines",
			header: window.shortTerm.header,
			sections: window.shortTerm.sections,
		},
	};
}

/** The one-time notices of the memory step; null when there are none. */
export function noticeBlock(window: WindowSnapshot): ContextBlock | null {
	if (window.notices.length === 0) return null;
	return {
		source: "memory.notice",
		authority: "host_record",
		freshness: "this_turn",
		body: {
			kind: "lines",
			sections: [{ items: window.notices.map((notice) => `- ${notice.text}`) }],
		},
	};
}

/** The prefetched earlier exchanges (memory wrote them as text); null when there are none. */
export function prefetchBlock(window: WindowSnapshot): ContextBlock | null {
	if (window.prefetch.text === "") return null;
	return {
		source: "memory.recall",
		authority: "reference",
		freshness: "past",
		body: { kind: "text", text: window.prefetch.text },
	};
}

/** Text a part of the host wrote as one piece (the World names hint, a handoff record). */
export function hostTextBlock(
	source: "world.names" | "specialist.handoff",
	text: string,
): ContextBlock {
	return {
		source,
		authority: source === "world.names" ? "reference" : "host_record",
		freshness: "this_turn",
		body: { kind: "text", text },
	};
}

/** A record the host keeps about a specialist session: the data only. */
export function specialistBlock(
	source: "specialist.work" | "specialist.viewing",
	value: unknown,
): ContextBlock {
	return {
		source,
		authority: "host_record",
		freshness: "this_turn",
		certainty: "host_confirmed",
		body: { kind: "json", value },
	};
}

export type OperationSource =
	| "operation.action"
	| "operation.recognition"
	| "operation.delegation"
	| "operation.drawing"
	| "operation.image"
	| "operation.music"
	| "operation.command_question";

/** The result of an operation the host ran for this turn: the data only. */
export function operationBlock(
	source: OperationSource,
	value: unknown,
): ContextBlock {
	return {
		source,
		authority: "host_record",
		freshness: "this_turn",
		certainty: "host_confirmed",
		body: { kind: "json", value },
	};
}

/** The research report a sub-agent returned, with the time it is phrased at. */
export function researchResultBlock(
	report: unknown,
	nowMs: number,
): ContextBlock {
	return {
		source: "research.result",
		authority: "reference",
		freshness: "this_turn",
		certainty: "unverified",
		body: { kind: "json", value: { ...promptTime(nowMs), report } },
	};
}

/**
 * A failed research answer: the failure code, the projection the sub-agent left (if any) and the time. The answer
 * to it is built apart from the layers (see `researchResultContext`), so the block only carries what that needs.
 */
export function researchFailureBlock(
	failureCode: string,
	projection: string | undefined,
	nowMs: number,
): ContextBlock {
	return {
		source: "research.failure",
		authority: "host_record",
		freshness: "this_turn",
		certainty: "host_confirmed",
		body: { kind: "json", value: { failureCode, projection, nowMs } },
	};
}
