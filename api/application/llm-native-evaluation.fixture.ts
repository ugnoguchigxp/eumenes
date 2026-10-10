import { z } from "zod";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
	requirementProfileData,
	publicUrl,
	utcDateTime,
} from "../domains/capabilities/contracts";
import {
	validateRequirementSchema,
	requirementValueMatches,
} from "../domains/capabilities";
import {
	checkStatus,
	draftReportBase,
} from "../domains/agent-runtime/contracts/requirements";
import { asrLanguages } from "../domains/settings/contracts";
import { canonicalRequirementJson } from "../domains/capabilities";
import { emotionSchema } from "../domains/delivery";
import type { Report } from "../domains/agent-runtime";
import type { AcquisitionPort } from "../domains/web-research";
const requirementsCase = z
	.object({
		id: z.string().min(1),
		suite: z.literal("requirements"),
		engine: z.enum(["default", "codex_luna"]),
		request: z.string().min(1).max(8000),
		profiles: z
			.array(z.object({ id: z.string(), file: z.string() }).strict())
			.min(1)
			.max(4),
		sources: z
			.array(
				z
					.object({
						url: publicUrl,
						title: z.string().max(200),
						body: z.string().max(1000000),
						fetchedAt: utcDateTime,
					})
					.strict(),
			)
			.min(1)
			.max(5),
		expected: z
			.object({
				outcome: z.union([
					draftReportBase.shape.outcome,
					z.literal("rejected"),
				]),
				checks: z.array(
					z
						.object({
							profileId: z.string(),
							localId: z.string(),
							status: checkStatus,
							value: z.json().optional(),
						})
						.strict(),
				),
				semanticAssertions: z.array(z.string()),
			})
			.strict(),
	})
	.strict();
const deliveryCase = z
	.object({
		id: z.string(),
		suite: z.literal("delivery"),
		text: z.string().min(1).max(600),
		turns: z.array(
			z
				.object({ role: z.enum(["user", "assistant"]), text: z.string() })
				.strict(),
		),
		expected: z.object({ emotion: emotionSchema }).strict(),
	})
	.strict();
const voiceCase = z
	.object({
		id: z.string(),
		suite: z.literal("voice-language"),
		text: z.string().min(1).max(8000),
		allowedLanguages: z.array(z.string()).min(1),
		expected: z
			.object({
				status: z.enum(["allowed", "not_allowed", "unverified"]),
				languages: z.array(z.string()).optional(),
			})
			.strict(),
	})
	.strict();
export const evaluationCases = z
	.object({
		version: z.literal(1),
		cases: z
			.array(
				z.discriminatedUnion("suite", [
					requirementsCase,
					deliveryCase,
					voiceCase,
				]),
			)
			.min(1),
	})
	.strict();
export type EvaluationCase = z.infer<typeof evaluationCases>["cases"][number];
export type RequirementsCase = Extract<
	EvaluationCase,
	{ suite: "requirements" }
>;
export function loadEvaluationCases(path: string) {
	const data = evaluationCases.parse(JSON.parse(readFileSync(path, "utf8")));
	if (new Set(data.cases.map((c) => c.id)).size !== data.cases.length)
		throw new Error("duplicate_evaluation_case");
	const profiles = new Map<string, z.infer<typeof requirementProfileData>>();
	for (const c of data.cases)
		if (c.suite === "requirements") {
			if (new Set(c.sources.map((s) => s.url)).size !== c.sources.length)
				throw new Error("duplicate_evaluation_source");
			for (const p of c.profiles) {
				const profile = requirementProfileData.parse(
					JSON.parse(readFileSync(resolve(dirname(path), p.file), "utf8")),
				);
				for (const r of profile.requirements)
					validateRequirementSchema(r.valueSchema);
				profiles.set(`${c.id}:${p.id}`, profile);
			}
			for (const e of c.expected.checks)
				if (
					!c.profiles.some(
						(p) =>
							p.id === e.profileId &&
							profiles
								.get(`${c.id}:${p.id}`)!
								.requirements.some((r) => r.id === e.localId),
					)
				)
					throw new Error("invalid_evaluation_reference");
		}
	for (const c of data.cases) {
		if (
			c.suite === "voice-language" &&
			c.allowedLanguages.some(
				(language) => !asrLanguages.some(([code]) => code === language),
			)
		)
			throw new Error("invalid_evaluation_language");
		if (c.suite !== "requirements") continue;
		if (
			new Set(c.profiles.map((p) => p.id)).size !== c.profiles.length ||
			new Set(c.expected.checks.map((e) => `${e.profileId}:${e.localId}`))
				.size !== c.expected.checks.length
		)
			throw new Error("invalid_evaluation_reference");
		if (c.sources.reduce((n, s) => n + Buffer.byteLength(s.body), 0) > 1048576)
			throw new Error("evaluation_capacity_exceeded");
		for (const e of c.expected.checks) {
			const r = profiles
				.get(`${c.id}:${e.profileId}`)!
				.requirements.find((r) => r.id === e.localId)!;
			if (
				Object.hasOwn(e, "value") &&
				(["unknown", "not_applicable"].includes(e.status)
					? e.value !== null
					: !requirementValueMatches(r.valueSchema, e.value))
			)
				throw new Error("invalid_evaluation_expected");
			if (e.status === "not_applicable" && !r.allowNotApplicable)
				throw new Error("invalid_evaluation_expected");
		}
	}
	return { cases: data.cases, profiles };
}
/** Exact URL lookup only; no scenario or query classifier and no network access. */
export function fixedAcquisition(
	sources: RequirementsCase["sources"],
): AcquisitionPort["execute"] {
	return async (request) => {
		const observedAt = new Date().toISOString();
		const source =
			request.operation === "read"
				? sources.find((s) => s.url === request.url)
				: null;
		if (request.operation === "read" && !source)
			throw new Error("fixture_source_not_found");
		const bodies = source
			? [
					{
						url: source.url,
						title: source.title,
						text: source.body,
						fetchedAt: source.fetchedAt,
						acquisitionTruncated: false,
					},
				]
			: [];
		return {
			freshUntilMs: null,
			bodies,
			result: {
				provider: "llm-fetch@0.1.2",
				observedAt,
				cache: "bypass",
				hits:
					request.operation === "lookup"
						? sources.map((s) => ({
								url: s.url,
								title: s.title,
								snippet: s.body.slice(0, 250),
								provider: "fixture",
								trust: "untrusted",
								tainted: true,
								verification: "search_summary",
							}))
						: [],
				documents: bodies.map((b) => ({
					...b,
					text: b.text.slice(0, 12000),
					truncated: b.text.length > 12000,
					trust: "untrusted",
					tainted: true,
					verification: "source_read",
					guardDecision: "allow",
					guardReasonCodes: [],
				})),
				failures: [],
			},
		};
	};
}
export function compareRequirementResult(
	c: RequirementsCase,
	report: Report | null,
	registered: Map<string, string>,
) {
	if (c.expected.outcome === "rejected") return report === null;
	if (report?.version !== 3 || report.outcome !== c.expected.outcome)
		return false;
	if (report.requirements.items.length !== report.requirements.checks.length)
		return false;
	return c.expected.checks.every((expected) => {
		const item = report.requirements.items.find(
			(i) =>
				i.origin.kind === "profile" &&
				i.origin.revisionId === registered.get(expected.profileId) &&
				i.origin.localId === expected.localId,
		);
		const check = report.requirements.checks.find(
			(v) => v.requirementId === item?.id,
		);
		return (
			check?.status === expected.status &&
			(!Object.hasOwn(expected, "value") ||
				canonicalRequirementJson(check.value) ===
					canonicalRequirementJson(expected.value))
		);
	});
}
