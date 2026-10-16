import { systemContext } from "../../../infrastructure/system-context";
import type { GuardReviewInput, GuardReviewDecision } from "llm-fetch";

const contentReviewInstructions = systemContext(
	"web-research.contexts.content-review.content-review-instructions",
	{},
);

export const contentReviewSchema = {
	type: "object",
	properties: {
		documentKind: {
			type: "string",
			enum: ["source_content", "injection", "uncertain"],
		},
		classifications: {
			type: "array",
			items: {
				type: "object",
				properties: {
					findingIndex: { type: "integer" },
					kind: {
						type: "string",
						enum: [
							"descriptive_content",
							"documented_human_procedure",
							"agent_directive",
							"authority_claim",
							"secret_request",
							"uncertain",
						],
					},
				},
				required: ["findingIndex", "kind"],
				additionalProperties: false,
			},
		},
	},
	required: ["documentKind", "classifications"],
	additionalProperties: false,
} as const;
export type ContentReviewGenerate = (
	messages: { role: "system" | "user"; content: string }[],
	signal: AbortSignal,
) => Promise<string>;

export function createWebContentReview(generate: ContentReviewGenerate) {
	return async (input: GuardReviewInput): Promise<GuardReviewDecision> => {
		const signal = input.signal ?? AbortSignal.timeout(30_000);
		signal.throwIfAborted();
		if (input.findings.length > 32) return { decision: "uncertain" };
		const value = await generate(
			[
				{ role: "system", content: contentReviewInstructions },
				{
					role: "user",
					content: JSON.stringify({
						requestedUse: input.requestedUse,
						document: { source: input.source, segments: input.segments },
						heuristicFindings: input.findings.map((finding, findingIndex) => ({
							findingIndex,
							...finding,
						})),
					}),
				},
			],
			signal,
		);
		signal.throwIfAborted();
		try {
			const parsed = JSON.parse(value);
			if (
				!parsed ||
				typeof parsed !== "object" ||
				Array.isArray(parsed) ||
				Object.keys(parsed).sort().join(",") !==
					"classifications,documentKind" ||
				!Array.isArray(parsed.classifications) ||
				parsed.classifications.length !== input.findings.length
			)
				return { decision: "uncertain" };
			if (parsed.documentKind !== "source_content")
				return {
					decision:
						parsed.documentKind === "injection" ? "injection" : "uncertain",
				};
			const seen = new Set<number>();
			for (const item of parsed.classifications) {
				if (
					!item ||
					typeof item !== "object" ||
					Array.isArray(item) ||
					Object.keys(item).sort().join(",") !== "findingIndex,kind" ||
					!Number.isInteger(item.findingIndex) ||
					item.findingIndex < 0 ||
					item.findingIndex >= input.findings.length ||
					seen.has(item.findingIndex)
				)
					return { decision: "uncertain" };
				seen.add(item.findingIndex);
				if (
					!["descriptive_content", "documented_human_procedure"].includes(
						item.kind,
					)
				)
					return { decision: "injection" };
			}
			return { decision: "source_content" };
		} catch {
			return { decision: "uncertain" };
		}
	};
}
