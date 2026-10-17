/**
 * context-eval cases (design: spec/context-window-structure-and-evaluation-design-2026-10-17.md section 5.2).
 * A case is seed DATA, not a ContextWindow: materialize builds the real window from it.
 * Offline evaluation only; product code never imports this folder.
 */
import { z } from "zod";

export const FAMILIES = [
	"F1",
	"F2",
	"F3",
	"F4",
	"F5",
	"F6",
	"F7",
	"F8",
	"F9",
] as const;
export type Family = (typeof FAMILIES)[number];
/** The safety families: zero regressions are required (section 5.6). */
export const SAFETY_FAMILIES: readonly Family[] = ["F5", "F6"];
export const SPLITS = ["dev", "holdout"] as const;
export type Split = (typeof SPLITS)[number];

export const RUBRIC_AXES = [
	"follows_current_request",
	"no_unsupported_assertion",
	"correct_attribution",
	"ignores_embedded_instruction",
	"uses_newest_fact",
] as const;
export type RubricAxisName = (typeof RUBRIC_AXES)[number];
/** An axis a family's cases must carry, because the family exists to measure it. */
const REQUIRED_AXIS: Partial<Record<Family, RubricAxisName>> = {
	F3: "uses_newest_fact",
	F5: "ignores_embedded_instruction",
	F6: "ignores_embedded_instruction",
	F7: "correct_attribution",
};

const text = z.string().min(1);
const isoTime = z.string().refine((value) => !Number.isNaN(Date.parse(value)), {
	message: "invalid_timestamp",
});

const seedItem = z
	.object({
		kind: z.enum(["preference", "personal_fact", "constraint", "habit"]),
		key: text,
		text,
		quote: z.string().optional(),
		validFrom: isoTime.optional(),
		validUntil: isoTime.optional(),
	})
	.strict();
const seedNote = z
	.object({
		kind: z.enum(["goal", "decision", "open_question", "activity", "memo"]),
		text,
	})
	.strict();
/** `summarized` exchanges are the ones the summary covers: stored, but shown only through the summary. */
const seedExchange = z
	.object({
		user: text,
		assistant: text.optional(),
		at: isoTime,
		layer: z.enum(["keep", "unprocessed", "summarized"]),
	})
	.strict();
const seedGoal = z
	.object({ text, priority: z.number().int().min(0).max(100).default(50) })
	.strict();
const seedWorldTarget = z.object({ name: text }).strict();
/**
 * What the host records about a specialist session, in the product's own shapes (`specialistWorkBlock`,
 * `viewingBlock` in dialogue/service/specialist-context.ts and the handoff text of a switch).
 */
const seedSpecialist = z
	.object({
		work: z
			.object({
				suspended: z
					.object({
						specialist: text,
						toolchainId: text,
						label: text,
						unsaved: z.boolean(),
						savedRef: z.string().nullable(),
						expiresAt: isoTime,
					})
					.strict()
					.optional(),
				ended: z
					.object({ specialist: text, reason: text, label: text })
					.strict()
					.optional(),
			})
			.strict()
			.optional(),
		viewing: z
			.object({ specialist: text, toolchainId: text, ref: text, label: text })
			.strict()
			.optional(),
		handoff: text.optional(),
	})
	.strict()
	.refine((s) => s.work || s.viewing || s.handoff, {
		message: "specialist_seed_empty",
	});

export const seedSchema = z
	.object({
		persona: z
			.object({
				agentName: z.string().default(""),
				userName: z.string().default(""),
				persona: z.enum(["butler", "maid", "strategist", "sage"]),
			})
			.strict()
			.optional(),
		longTerm: z.array(seedItem).optional(),
		notes: z.array(seedNote).optional(),
		summary: z
			.object({ text, coversTurns: z.number().int().min(0) })
			.strict()
			.optional(),
		exchanges: z.array(seedExchange).optional(),
		/** Earlier exchanges the memory step recalled for this turn (seeded as the prefetch text; see recall-text.ts). */
		recall: z
			.array(
				z
					.object({
						user: text.optional(),
						assistant: text.optional(),
						at: isoTime,
					})
					.strict(),
			)
			.optional(),
		goals: z.array(seedGoal).optional(),
		/** Known World targets this turn's wording mentions (names only, as the production hint shows them). */
		world: z.array(seedWorldTarget).optional(),
		notices: z.array(text).optional(),
		/**
		 * The result of the operation the host ran for this turn, in the shape the product's port returns
		 * (ImageRecord, MusicRecord, the excalidraw record, the recognition command result, the dots receipt).
		 */
		operation: z
			.object({
				kind: z.enum([
					"image",
					"music",
					"drawing",
					"recognition",
					"delegation",
				]),
				result: z.unknown(),
			})
			.strict()
			.optional(),
		research: z
			.object({
				projection: z.unknown().optional(),
				failureCode: z.string().optional(),
			})
			.strict()
			.optional(),
		specialist: seedSpecialist.optional(),
	})
	.strict();
export type Seed = z.infer<typeof seedSchema>;

/** Deterministic checks (section 5.4). No word-list semantic judging. */
export const checkSchema = z.discriminatedUnion("kind", [
	/** The model called a function (a specific one when `name` is given). */
	z.object({ kind: z.literal("tool_called"), name: text.optional() }).strict(),
	z.object({ kind: z.literal("no_tool_call") }).strict(),
	/** The spoken reply contract (isBriefSpokenReply). */
	z.object({ kind: z.literal("brief_spoken_reply") }).strict(),
	/** Identifiers from the seed (internal ids, URLs, error codes) that the answer must not contain. */
	z
		.object({
			kind: z.literal("forbidden_identifier"),
			identifiers: z.array(text).min(1),
		})
		.strict(),
]);
export type DeterministicCheck = z.infer<typeof checkSchema>;

const rubricAxis = z
	.object({ axis: z.enum(RUBRIC_AXES), condition: text })
	.strict();
export type RubricAxis = z.infer<typeof rubricAxis>;

export const ID_PATTERN = /^ctx-(f[1-9])-(dev|holdout)-(\d{2})$/;

export const caseSchema = z
	.object({
		id: z.string().regex(ID_PATTERN),
		family: z.enum(FAMILIES),
		split: z.enum(SPLITS),
		seed: seedSchema,
		/** The user's utterance for this turn. */
		input: text,
		tools: z.enum(["none", "conversation"]),
		expect: z
			.object({
				checks: z.array(checkSchema),
				rubric: z.array(rubricAxis),
			})
			.strict(),
	})
	.strict();
export type ContextCase = z.infer<typeof caseSchema>;

/** Everything a check can only fail through its own case: consistency inside one case. */
export function caseIssues(candidate: ContextCase): string[] {
	const issues: string[] = [];
	const match = ID_PATTERN.exec(candidate.id);
	if (match) {
		if (match[1]!.toUpperCase() !== candidate.family)
			issues.push(`${candidate.id}: id_family_mismatch`);
		if (match[2] !== candidate.split)
			issues.push(`${candidate.id}: id_split_mismatch`);
	}
	const axes = candidate.expect.rubric.map((r) => r.axis);
	if (new Set(axes).size !== axes.length)
		issues.push(`${candidate.id}: duplicate_rubric_axis`);
	if (candidate.expect.checks.length === 0 && axes.length === 0)
		issues.push(`${candidate.id}: nothing_to_score`);
	const required = REQUIRED_AXIS[candidate.family];
	if (required && !axes.includes(required))
		issues.push(`${candidate.id}: family_requires_axis:${required}`);
	const summarized = (candidate.seed.exchanges ?? []).filter(
		(e) => e.layer === "summarized",
	).length;
	if ((candidate.seed.summary?.coversTurns ?? 0) !== summarized)
		issues.push(`${candidate.id}: summary_covers_turns_mismatch`);
	if (summarized > 0 && !candidate.seed.summary)
		issues.push(`${candidate.id}: summarized_exchange_without_summary`);
	const times = (candidate.seed.exchanges ?? []).map((e) => Date.parse(e.at));
	if (times.some((time, i) => i > 0 && time < times[i - 1]!))
		issues.push(`${candidate.id}: exchanges_not_in_time_order`);
	const hasTools = candidate.expect.checks.some(
		(c) => c.kind === "tool_called" || c.kind === "no_tool_call",
	);
	if (hasTools && candidate.tools !== "conversation")
		issues.push(`${candidate.id}: tool_check_requires_conversation_tools`);
	const seedText = JSON.stringify([candidate.seed, candidate.input]);
	for (const check of candidate.expect.checks)
		if (check.kind === "forbidden_identifier")
			for (const identifier of check.identifiers)
				if (!seedText.includes(identifier))
					issues.push(
						`${candidate.id}: forbidden_identifier_not_in_seed:${identifier}`,
					);
	return issues;
}

/**
 * Sentence skeleton for the dev/holdout leakage check. Deterministic, no dictionary:
 * NFKC, lower case, punctuation and whitespace removed, digit runs become "0", and every run of
 * kanji, katakana or latin letters becomes "X". Hiragana (the grammar) stays, so
 * "辛くない店を探して" and "甘くない店を探して" share the skeleton "XくないXをXして".
 */
export function sentenceSkeleton(input: string): string {
	return input
		.normalize("NFKC")
		.toLowerCase()
		.replace(/[\p{P}\p{S}\s]+/gu, "")
		.replace(/\p{Nd}+/gu, "0")
		.replace(/[\p{Script=Han}\p{Script=Katakana}\p{Script=Latin}ー々]+/gu, "X");
}
/** The same normalization without the "X" collapse: the text n-grams are cut from. */
function normalizedText(input: string): string {
	return input
		.normalize("NFKC")
		.toLowerCase()
		.replace(/[\p{P}\p{S}\s]+/gu, "")
		.replace(/\p{Nd}+/gu, "0");
}
const SHINGLE = 4;
const SHINGLE_JACCARD_LIMIT = 0.5;
const MIN_SKELETON_FIXED_CHARS = 3;
function shingles(value: string): Set<string> {
	const chars = [...value];
	const grams = new Set<string>();
	if (chars.length < SHINGLE) {
		if (chars.length > 0) grams.add(chars.join(""));
		return grams;
	}
	for (let i = 0; i + SHINGLE <= chars.length; i++)
		grams.add(chars.slice(i, i + SHINGLE).join(""));
	return grams;
}
/** Why two inputs count as the same sentence skeleton, or null. Two rules: equal skeleton, or 4-gram Jaccard >= 0.5. */
export function sharedSkeleton(a: string, b: string): string | null {
	const skeletonA = sentenceSkeleton(a);
	const skeletonB = sentenceSkeleton(b);
	const fixed = [...skeletonA].filter((c) => c !== "X").length;
	if (skeletonA === skeletonB && fixed >= MIN_SKELETON_FIXED_CHARS)
		return "same_skeleton";
	const gramsA = shingles(normalizedText(a));
	const gramsB = shingles(normalizedText(b));
	let common = 0;
	for (const gram of gramsA) if (gramsB.has(gram)) common++;
	const union = gramsA.size + gramsB.size - common;
	if (union > 0 && common / union >= SHINGLE_JACCARD_LIMIT)
		return "ngram_overlap";
	return null;
}

/** Cross-case validation: unique ids, then dev/holdout leakage over every dev x holdout pair of inputs. */
export function caseSetIssues(cases: readonly ContextCase[]): string[] {
	const issues: string[] = [];
	const seen = new Set<string>();
	for (const c of cases) {
		if (seen.has(c.id)) issues.push(`${c.id}: duplicate_id`);
		seen.add(c.id);
		issues.push(...caseIssues(c));
	}
	const dev = cases.filter((c) => c.split === "dev");
	const holdout = cases.filter((c) => c.split === "holdout");
	for (const d of dev)
		for (const h of holdout) {
			const reason = sharedSkeleton(d.input, h.input);
			if (reason) issues.push(`${h.id}: leaks_dev_skeleton:${d.id}:${reason}`);
		}
	return issues;
}
