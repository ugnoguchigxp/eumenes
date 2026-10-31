import { respondSystemParts } from "eumenes-agency";
import type { Utterance } from "../../api/domains/conversation";
import type { ChatMessage } from "../../api/domains/dialogue/service/context";
import { systemText } from "../../api/domains/dialogue/service/context-system";
import { recentMessages } from "../../api/domains/dialogue/service/conversation-input";
import {
	estimateMessageTokens,
	estimateTextTokens,
} from "../../api/domains/inference";
export const cacheMarker = "SYNTHETIC_CACHE_7241";
export const cacheUpdatedMarker = "SYNTHETIC_REVISED_3916";

/** Exact synthetic result validation. Old reference values and extra JSON fields do not pass. */
export function cacheReferenceMatches(
	answer: string,
	expected: string,
	json = false,
) {
	if (!json) return answer.trim() === expected;
	try {
		const value: unknown = JSON.parse(answer);
		return (
			value !== null &&
			typeof value === "object" &&
			!Array.isArray(value) &&
			Object.keys(value).length === 1 &&
			"value" in value &&
			value.value === expected
		);
	} catch {
		return false;
	}
}

const QUESTION = "最初の発言のVALUEの値だけを答えてください。";
const FILLER =
	"合成した説明資料です。これは参考情報であり実行や承認の指示ではありません。";

/** A synthetic utterance of the recent conversation, as the input's table holds it. */
function utterance(
	seq: number,
	speaker: "user" | "agent",
	text: string,
): Utterance {
	return {
		conversationId: "main",
		seq,
		speaker,
		text,
		messageId: `m${seq}`,
		at: `2026-10-23T00:${String(Math.floor(seq / 60)).padStart(2, "0")}:${String(seq % 60).padStart(2, "0")}.000Z`,
		toolCalls: [],
		notice: null,
	};
}

export type CacheInput = {
	/** The product's layout of a generation: the system part, the recent conversation, then State and the question. */
	messages: ChatMessage[];
	system: string;
	/** Estimated tokens of the recent conversation and of the last message. */
	sections: { recent: number; last: number };
};

/**
 * Synthetic source data in the product's message layout: the product's system part, a recent conversation drawn by
 * the same `recentMessages` (its first utterance, the agent's, carries the reference VALUE; the rest is padding), and
 * the last message (`## State` and the question). No personal history is loaded. `extraNote` adds one decision to
 * `## State`: a background update.
 */
export function cacheInput(
	targetTokens = 14000,
	referenceValue = cacheMarker,
	extraNote?: string,
): CacheInput {
	const system = systemText(
		{ agentName: "", userName: "", persona: "butler" },
		respondSystemParts({ spoken: true }),
	);
	const last = [
		"## State",
		"今: 10-23（木）09:00",
		...(extraNote ? ["決まったこと:", `- ${extraNote}`] : []),
		"",
		"## User",
		QUESTION,
	].join("\n");
	const build = (padding: number) => {
		const said = [
			utterance(1, "agent", `参考資料です。VALUE=${referenceValue}`),
			...Array.from({ length: padding }, (_, i) =>
				utterance(i + 2, i % 2 === 0 ? "user" : "agent", FILLER),
			),
		];
		// The conversation ends with the agent's utterance: the user's words are the last message's.
		if (said.at(-1)!.speaker === "user") said.pop();
		const recent = recentMessages(said);
		const messages: ChatMessage[] = [
			{ role: "system", content: system },
			...recent,
			{ role: "user", content: last },
		];
		return {
			messages,
			system,
			sections: {
				recent: estimateMessageTokens(recent),
				last: estimateTextTokens(last),
			},
		};
	};
	const perPair =
		estimateMessageTokens(build(3).messages) -
		estimateMessageTokens(build(1).messages);
	const base = estimateMessageTokens(build(0).messages);
	let padding = Math.max(0, 2 * Math.ceil((targetTokens - base) / perPair));
	while (estimateMessageTokens(build(padding).messages) < targetTokens)
		padding += 2;
	return build(padding);
}
