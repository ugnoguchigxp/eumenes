import { z } from "zod";
import type { LarmCallOptions } from "../api/domains/larm/contracts";
import {
	transcriptLanguageMessages,
	transcriptAssessmentResult,
	transcriptLanguageStatus,
} from "../api/domains/voice-dialogue/service/transcript-language";
import { voiceAssessmentCases } from "./voice-assessment-cases";

export type AssessmentCase = (typeof voiceAssessmentCases)[number];
type Assessment = z.infer<typeof transcriptAssessmentResult>;

// Synthetic demonstrations differ from all evaluation inputs. No example-specific
// product branch is introduced; the model still makes every semantic decision.
const examples = [
	{
		input: { text: "昨日買った本の。", previousText: "", conversation: [] },
		output: {
			status: "identified",
			languages: ["ja"],
			confidence: 0.95,
			relation: "independent",
			readiness: "waiting",
			relationConfidence: 0.95,
			readinessConfidence: 0.95,
		},
	},
	{
		input: {
			text: "小学生向けに説明して。",
			previousText: "重力波について。",
			conversation: [],
		},
		output: {
			status: "identified",
			languages: ["ja"],
			confidence: 0.95,
			relation: "continuation",
			readiness: "ready",
			relationConfidence: 0.95,
			readinessConfidence: 0.9,
		},
	},
	{
		input: {
			text: "青で。",
			previousText: "",
			conversation: [{ role: "assistant", text: "何色にしますか？" }],
		},
		output: {
			status: "identified",
			languages: ["ja"],
			confidence: 0.9,
			relation: "independent",
			readiness: "ready",
			relationConfidence: 0.95,
			readinessConfidence: 0.95,
		},
	},
	{
		input: { text: "?", previousText: "", conversation: [] },
		output: {
			status: "undetermined",
			languages: [],
			confidence: 0,
			relation: "independent",
			readiness: "uncertain",
			relationConfidence: 0.95,
			readinessConfidence: 0,
		},
	},
	{
		input: {
			text: "Explica qué es la gravedad.",
			previousText: "",
			conversation: [],
		},
		output: {
			status: "identified",
			languages: ["es"],
			confidence: 0.95,
			relation: "independent",
			readiness: "ready",
			relationConfidence: 0.95,
			readinessConfidence: 0.95,
		},
	},
];
export const variants = [
	"baseline",
	"schema",
	"examples",
	"budget128",
	"stream",
	"short-schema",
] as const;
export type Variant = (typeof variants)[number];
export function assessmentRequest(c: AssessmentCase, variant: Variant) {
	const messages = transcriptLanguageMessages(c.text, {
		previousText: c.previousText,
		conversation: c.conversation,
	});
	if (variant === "short-schema") {
		const boundary = messages[0]!.content.lastIndexOf("\nOUTPUT_SCHEMA=");
		if (boundary < 0) throw new Error("assessment_schema_boundary_missing");
		messages[0]!.content =
			messages[0]!.content.slice(0, boundary) +
			"\n出力項目: status(identifiedまたはundetermined)、languages(languageCodesから選んだ配列)、confidence(言語の信頼度)、relation、readiness、relationConfidence、readinessConfidence。identifiedの言語は重複なし1〜4件、undeterminedは空配列。信頼度は0〜1の数値です。全7項目だけを含むJSONを返してください。";
	}
	if (variant === "examples")
		messages[0]!.content +=
			"\n以下は形式と判断境界の例です。値は入力ごとに判断し、項目名を省略せず空白・改行のないJSONを返してください。\n<examples>\n" +
			examples
				.map(
					(e) =>
						`<example>\ninput=${JSON.stringify(e.input)}\noutput=${JSON.stringify(e.output)}\n</example>`,
				)
				.join("\n") +
			"\n</examples>";
	const options: LarmCallOptions = {
		maxOutputTokens: variant === "budget128" ? 128 : 512,
		jsonOutput: true,
		contextPolicy: "exact",
		sessionRole: "main",
		...(variant === "schema" || variant === "short-schema"
			? { jsonSchema: z.toJSONSchema(transcriptAssessmentResult) }
			: {}),
	};
	return { messages, options, stream: variant === "stream" };
}
export function scoreAssessment(c: AssessmentCase, a: Assessment) {
	const languageStatus = transcriptLanguageStatus(a, ["ja"]);
	// Mirrors the existing host gates for diagnostics; never used for product decisions.
	const accepted =
		languageStatus === "allowed" &&
		a.relation !== "uncertain" &&
		a.relationConfidence >= 0.8 &&
		a.readiness === "ready" &&
		a.readinessConfidence >= 0.8;
	const expectedAccepted =
		c.languages.length > 0 &&
		c.languages.every((l) => l === "ja") &&
		c.readiness === "ready" &&
		c.relation !== "uncertain";
	return {
		languageStatus,
		accepted,
		expectedAccepted,
		falseAccept: accepted && !expectedAccepted,
		falseReject: !accepted && expectedAccepted,
		pass:
			a.status === (c.languages.length ? "identified" : "undetermined") &&
			[...a.languages].sort().join() === [...c.languages].sort().join() &&
			(!c.languages.length || a.confidence >= 0.8) &&
			a.relation === c.relation &&
			a.relationConfidence >= 0.8 &&
			a.readiness === c.readiness &&
			(c.readiness === "uncertain" || a.readinessConfidence >= 0.8),
	};
}
