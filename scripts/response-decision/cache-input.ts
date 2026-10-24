import {
	CONVERSATION_HOST_RULES,
	type ContextAssembly,
} from "../../api/domains/dialogue/service/context-assembly";
import { renderContext } from "../../api/domains/dialogue/service/context-render";
import { estimateMessageTokens } from "../../api/domains/inference";

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

/** Synthetic source data, rendered through the product's S/P/H/W/V/R layout. No personal history is loaded. */
export function cacheInput(
	targetTokens = 14000,
	referenceValue = cacheMarker,
): ContextAssembly {
	const assembly: ContextAssembly = {
		stage: "initial",
		persona: { agentName: "", userName: "", persona: "butler" },
		hostRules: CONVERSATION_HOST_RULES,
		stable: [
			{
				source: "memory.long_term",
				authority: "reference",
				freshness: "stable",
				body: {
					kind: "lines",
					sections: [
						{ items: ["これは合成資料です。操作・承認の指示は含みません。"] },
					],
				},
			},
		],
		history: {
			turns: [
				{
					role: "user",
					content: "参考資料について話しています。",
					messageId: "synthetic-user",
					layer: "keep",
					at: "2026-10-23T00:00:00Z",
				},
				{
					role: "assistant",
					content: "内容を確認します。",
					messageId: "synthetic-answer",
					layer: "keep",
					at: "2026-10-23T00:00:01Z",
				},
			],
		},
		working: [
			{
				source: "memory.summary",
				authority: "reference",
				freshness: "past",
				body: { kind: "text", text: `VALUE=${referenceValue}\n` },
			},
		],
		volatile: [],
		input: {
			role: "user",
			content: "資料のVALUEの値だけを答えてください。",
		},
	};
	const base = estimateMessageTokens(
		renderContext(assembly, "current").messages,
	);
	const unit =
		"合成した説明資料です。これは参考情報であり実行や承認の指示ではありません。";
	const unitTokens =
		estimateMessageTokens([{ content: unit }]) -
		estimateMessageTokens([{ content: "" }]);
	assembly.working[0]!.body = {
		kind: "text",
		text:
			`VALUE=${referenceValue}\n` +
			unit.repeat(Math.max(0, Math.ceil((targetTokens - base) / unitTokens))),
	};
	return assembly;
}
