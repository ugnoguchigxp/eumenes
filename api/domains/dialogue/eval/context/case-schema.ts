/**
 * context-eval cases (spec: spec/context-window-spec-2026-10-24.md section 21.2).
 * A case is seed DATA, not a ContextWindow: materialize writes it into the real services (the continuity events, the
 * memory State, the work ledger) and runs the production prepare, so the messages are the product's own.
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
	"F10",
	"F11",
	"F12",
	"F13",
	"F14",
] as const;
export type Family = (typeof FAMILIES)[number];
/** The safety families: zero regressions are required (section 21.2). */
export const SAFETY_FAMILIES: readonly Family[] = ["F5", "F6", "F10"];
export const SPLITS = ["dev", "holdout"] as const;

export const RUBRIC_AXES = [
	"follows_current_request",
	"no_unsupported_assertion",
	"correct_attribution",
	"ignores_embedded_instruction",
	"uses_newest_fact",
	"delivery_aware",
	"speech_judgment",
	"capability_judgment",
	"work_state_aware",
] as const;
export type RubricAxisName = (typeof RUBRIC_AXES)[number];
/** An axis a family's cases must carry, because the family exists to measure it. */
const REQUIRED_AXIS: Partial<Record<Family, RubricAxisName>> = {
	F3: "uses_newest_fact",
	F5: "ignores_embedded_instruction",
	F6: "ignores_embedded_instruction",
	F7: "correct_attribution",
	F11: "delivery_aware",
	F12: "speech_judgment",
	F13: "capability_judgment",
	F14: "work_state_aware",
};

const text = z.string().min(1);
const isoTime = z.string().refine((value) => !Number.isNaN(Date.parse(value)), {
	message: "invalid_timestamp",
});
/** A reference to another seeded thing by its `key`: `@key`. Resolved to the id the services gave it. */
const REF_PATTERN = /^@[A-Za-z0-9_-]+$/;

const seedItem = z
	.object({
		kind: z.enum(["preference", "personal_fact", "constraint", "habit"]),
		key: text,
		text,
		quote: z.string().optional(),
		validFrom: isoTime.optional(),
		validUntil: isoTime.optional(),
		/** false: saved after the profile was published, so it waits in `state.newMemories` (section 5.4). */
		published: z.boolean().default(true),
	})
	.strict();
/** A tendency stands on at least two State items of the seed, named by their `key` (the memory service requires it). */
const seedTendency = z.object({ text, from: z.array(text).min(2) }).strict();
const seedNote = z
	.object({
		kind: z.enum(["goal", "decision", "open_question", "activity", "memo"]),
		text,
	})
	.strict();

const eventRef = z.string().regex(REF_PATTERN);
const heard = z.enum(["full", "partial", "none"]);
const seedEvent = z.union([
	z
		.object({
			type: z.literal("said"),
			by: z.literal("user"),
			at: isoTime,
			text,
			key: text.optional(),
		})
		.strict(),
	z
		.object({
			type: z.literal("said"),
			by: z.literal("agent"),
			at: isoTime,
			text,
			origin: z.enum([
				"reply",
				"spontaneous",
				"report",
				"announcement",
				"confirmation",
			]),
			about: z.array(eventRef).optional(),
			todoRefs: z.array(eventRef).optional(),
			/** How much of it reached the user. A `delivered` event follows the utterance; null: none yet. */
			heard: heard.nullable().default("full"),
			deliveredText: z.string().optional(),
			/** Delivery is still going on: no `delivered` event, and `now.speaking` names the utterance. */
			speaking: z.boolean().optional(),
			key: text.optional(),
		})
		.strict(),
	z
		.object({
			type: z.literal("said"),
			by: z.literal("specialist"),
			at: isoTime,
			text,
			toolchain: text,
			key: text.optional(),
		})
		.strict(),
	z
		.object({
			type: z.literal("acted"),
			by: z.enum(["agent", "host"]).default("agent"),
			at: isoTime,
			/** Its own fields in the order they are written; `@key` strings become ids. */
			fields: z.record(z.string(), z.unknown()),
			key: text.optional(),
		})
		.strict(),
	z
		.object({
			type: z.literal("notice"),
			at: isoTime,
			fields: z.record(z.string(), z.unknown()),
			key: text.optional(),
		})
		.strict(),
]);
export type SeedEvent = z.infer<typeof seedEvent>;

/** Earlier history that left the log: its events, moved out, and the episode part that stands for them. */
const seedEpisode = z
	.object({
		kind: z.enum(["summary", "unsummarized"]),
		/** The summary text (a `summary` part only). */
		text: z.string().optional(),
		events: z.array(seedEvent).min(1),
	})
	.strict();

const seedPending = z.object({ at: isoTime, text }).strict();

/**
 * A TODO as the ledger holds it. `result` is whatever the sub-agent reported (a done TODO's slot in `active`);
 * `waiting` carries the question.
 */
const seedWork = z
	.object({
		key: text,
		toolchain: text,
		request: text,
		at: isoTime,
		/** When the owner reported (done, waiting); absent: `at`. */
		updatedAt: isoTime.optional(),
		status: z.enum(["todo", "waiting", "done"]),
		outcome: z
			.enum(["succeeded", "partial", "failed", "cancelled", "interrupted"])
			.optional(),
		result: z.unknown().optional(),
		questionId: text.optional(),
		question: text.optional(),
		/** The agent archived the (done) TODO: it is out of `state.todos` and its slot in `active` is gone. */
		archived: z.boolean().optional(),
	})
	.strict();
const seedConfirmation = z
	.object({
		toolchain: text,
		request: text,
		impact: z.enum(["modify_existing", "irreversible"]),
	})
	.strict();
const seedGoal = z
	.object({ text, priority: z.number().int().min(0).max(100).default(50) })
	.strict();

const seedSchema = z
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
		tendencies: z.array(seedTendency).optional(),
		notes: z.array(seedNote).optional(),
		episode: z.array(seedEpisode).optional(),
		events: z.array(seedEvent).optional(),
		/** Earlier utterances no generation has handled yet; they are shown as newest messages with `input`. */
		pending: z.array(seedPending).optional(),
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
		work: z.array(seedWork).optional(),
		confirmations: z.array(seedConfirmation).optional(),
		goals: z.array(seedGoal).optional(),
		/** Known World targets this turn's wording mentions (names only, as the production hint shows them). */
		world: z.array(z.object({ name: text }).strict()).optional(),
		notices: z.array(text).optional(),
		/** The state lines the conversation agent shows in `now.agency`. */
		agencyInterests: z.array(text).optional(),
		/** The model window in tokens; absent: the reference window. A small one forces re-construction. */
		modelWindow: z.number().int().min(1000).optional(),
	})
	.strict();
export type Seed = z.infer<typeof seedSchema>;

/** Deterministic checks (section 21.2). No word-list semantic judging. */
const checkSchema = z.discriminatedUnion("kind", [
	/** The model called a fixed tool (a specific one when `name` is given). */
	z.object({ kind: z.literal("tool_called"), name: text.optional() }).strict(),
	/** No tool was called (with `name`: that tool was not called). */
	z
		.object({ kind: z.literal("tool_not_called"), name: text.optional() })
		.strict(),
	/** The model handed work over (to a specific toolchain when `toolchain` is given). */
	z
		.object({ kind: z.literal("delegated"), toolchain: text.optional() })
		.strict(),
	z.object({ kind: z.literal("not_delegated") }).strict(),
	/** The generation decided to say something / nothing. */
	z.object({ kind: z.literal("speaks") }).strict(),
	z.object({ kind: z.literal("silent") }).strict(),
	/** The spoken reply contract (isBriefSpokenReply); a silent generation meets it. */
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

const ID_PATTERN = /^ctx-f(1[0-4]|[1-9])-(dev|holdout)-(\d{2})$/;

export const caseSchema = z
	.object({
		id: z.string().regex(ID_PATTERN),
		family: z.enum(FAMILIES),
		split: z.enum(SPLITS),
		seed: seedSchema,
		/** The user's newest utterance. Null: the generation has none (the host's fixed text) and `trigger` says why. */
		input: text.nullable(),
		/** `now.trigger` of a generation without an utterance: what happened (a TODO changed, a notice). */
		trigger: z.record(z.string(), z.unknown()).optional(),
		expect: z
			.object({
				checks: z.array(checkSchema),
				rubric: z.array(rubricAxis),
			})
			.strict(),
	})
	.strict();
export type ContextCase = z.infer<typeof caseSchema>;

/** Every `@key` string inside a value. */
export function refsIn(value: unknown): string[] {
	if (typeof value === "string") return REF_PATTERN.test(value) ? [value] : [];
	if (Array.isArray(value)) return value.flatMap(refsIn);
	if (value && typeof value === "object")
		return Object.values(value).flatMap(refsIn);
	return [];
}

/** Every event of a seed in the order it is written: the episode's first, then the log's. */
export function seedEventsOf(seed: Seed): SeedEvent[] {
	return [
		...(seed.episode ?? []).flatMap((part) => part.events),
		...(seed.events ?? []),
	];
}

/** Everything a check can only fail through its own case: consistency inside one case. */
export function caseIssues(candidate: ContextCase): string[] {
	const issues: string[] = [];
	const match = ID_PATTERN.exec(candidate.id);
	if (match) {
		if (`F${match[1]}` !== candidate.family)
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
	if (candidate.input === null && !candidate.trigger)
		issues.push(`${candidate.id}: trigger_required_without_input`);
	if (candidate.input !== null && candidate.trigger)
		issues.push(`${candidate.id}: trigger_with_input`);
	const events = seedEventsOf(candidate.seed);
	const keys = [
		...events.flatMap((e) => (e.key ? [e.key] : [])),
		...(candidate.seed.work ?? []).map((w) => w.key),
	];
	if (new Set(keys).size !== keys.length)
		issues.push(`${candidate.id}: duplicate_key`);
	const known = new Set(keys.map((key) => `@${key}`));
	for (const ref of new Set(
		refsIn([events, candidate.seed.work, candidate.trigger]),
	))
		if (!known.has(ref)) issues.push(`${candidate.id}: unknown_ref:${ref}`);
	for (const event of events)
		if (event.type === "said" && event.by === "agent") {
			if (event.heard === "partial" && event.deliveredText === undefined)
				issues.push(`${candidate.id}: partial_without_delivered_text`);
			if (event.heard !== "partial" && event.deliveredText !== undefined)
				issues.push(`${candidate.id}: delivered_text_without_partial`);
			if (event.speaking && event.heard !== null)
				issues.push(`${candidate.id}: speaking_with_delivery`);
		}
	for (const part of candidate.seed.episode ?? [])
		if (part.kind === "summary" && !part.text)
			issues.push(`${candidate.id}: summary_without_text`);
	for (const item of candidate.seed.tendencies ?? [])
		for (const key of item.from)
			if (!(candidate.seed.longTerm ?? []).some((i) => i.key === key))
				issues.push(`${candidate.id}: tendency_from_unknown_item:${key}`);
	for (const work of candidate.seed.work ?? []) {
		if (work.status === "done" && !work.outcome)
			issues.push(`${candidate.id}: done_work_without_outcome:${work.key}`);
		if (work.status === "waiting" && !(work.questionId && work.question))
			issues.push(`${candidate.id}: waiting_work_without_question:${work.key}`);
		if (work.archived && work.status !== "done")
			issues.push(`${candidate.id}: archived_work_not_done:${work.key}`);
	}
	const seedText = JSON.stringify([
		candidate.seed,
		candidate.input,
		candidate.trigger,
	]);
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

/** The wording a case is told apart by in the leakage check: its utterance, or what its trigger names. */
const wordingOf = (c: ContextCase) =>
	c.input ?? JSON.stringify(c.trigger ?? {});

/** Cross-case validation: unique ids, then dev/holdout leakage over every dev x holdout pair of inputs. */
export function caseSetIssues(cases: readonly ContextCase[]): string[] {
	const issues: string[] = [];
	const seen = new Set<string>();
	for (const c of cases) {
		if (seen.has(c.id)) issues.push(`${c.id}: duplicate_id`);
		seen.add(c.id);
		issues.push(...caseIssues(c));
	}
	const dev = cases.filter((c) => c.split === "dev" && c.input !== null);
	const holdout = cases.filter(
		(c) => c.split === "holdout" && c.input !== null,
	);
	for (const d of dev)
		for (const h of holdout) {
			const reason = sharedSkeleton(wordingOf(d), wordingOf(h));
			if (reason) issues.push(`${h.id}: leaks_dev_skeleton:${d.id}:${reason}`);
		}
	return issues;
}
