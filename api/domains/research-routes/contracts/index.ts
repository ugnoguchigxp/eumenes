import { z } from "zod";

/** Frozen limits from the research-route learning plan (2026-10-09). */
export const limits = {
	keywordsMax: 400,
	keywordWordsMax: 16,
	factsBytes: 4096,
	evidenceChars: 400,
	candidateHits: 5,
	candidateBytes: 8192,
	routeBytes: 12288,
	totalBytes: 64 * 1024 * 1024,
	keysMax: 5000,
	operationRowsMax: 1024,
	operationBytesMax: 2 * 1024 * 1024,
	listLimitMax: 50,
	instructionMax: 2000,
	cursorBytes: 256,
	sweepLimit: 100,
	authorBodyBytes: 4096,
	contextRuleBytes: 512,
	authorTotalBytes: 8192,
	selectedBytes: 16384,
	draftDeadlineMs: 120_000,
	stepDeadlineMs: 30_000,
	controlMaxTokens: 2048,
} as const;
export const ttl = {
	candidateMs: 24 * 3600_000,
	idleMs: 14 * 24 * 3600_000,
	absoluteMs: 30 * 24 * 3600_000,
	retryAfterMs: 5 * 60_000,
	terminalMs: 24 * 3600_000,
	operationMs: 24 * 3600_000,
	historyMs: 30 * 24 * 3600_000,
	weatherFreshMs: 24 * 3600_000,
	quoteFreshMs: 7 * 24 * 3600_000,
	futureSkewMs: 5 * 60_000,
} as const;
export const validationPolicyVersion = 1;
export const keyVersion = 1;
export const jobKinds = {
	author: "research.skill-author",
	review: "research.context-review",
	sweep: "research.sweep",
	clear: "research.clear-sweep",
} as const;
export const ownerScope = "research-routes:owner";

const isoDate = z
	.string()
	.regex(/^\d{4}-\d{2}-\d{2}$/)
	.refine((v) => {
		const d = new Date(`${v}T00:00:00Z`);
		return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(v);
	}, "invalid_date");
const isoDateTime = z.string().datetime({ offset: true });
const hex64 = z.string().regex(/^[0-9a-f]{64}$/);
const uuid = z.string().uuid();

// ---------- search key ----------
export const weatherTarget = z
	.object({
		name: z.string().min(1).max(40),
		prefecture: z.string().min(1).max(40),
		granularity: z.literal("city"),
	})
	.strict();
export const quoteTarget = z
	.object({
		ticker: z.string().regex(/^[A-Z0-9.^-]{1,16}$/),
		market: z.string().min(1).max(16),
		currency: z.string().regex(/^[A-Z]{3}$/),
		priceKind: z.literal("regular"),
	})
	.strict();
export const weatherField = z.enum(["condition", "maxTemp", "minTemp"]);
export const quoteFields = [
	"asOf",
	"currency",
	"market",
	"price",
	"priceKind",
] as const;
const common = {
	keyVersion: z.literal(1),
	keywords: z.string().min(1).max(limits.keywordsMax),
	scope: z.literal("local:owner"),
	language: z.enum(["ja", "en"]),
	region: z.enum(["JP", "US"]),
	timeZone: z.string().min(1).max(64),
};
const weatherFields = z
	.array(weatherField)
	.min(1)
	.max(3)
	.refine(
		(a) =>
			a.includes("condition") && a.every((v, i) => i === 0 || a[i - 1]! < v),
		"fields_must_be_sorted_unique_with_condition",
	);
export const weatherSpec = z
	.object({
		...common,
		purpose: z.literal("weather"),
		target: weatherTarget,
		requiredFields: weatherFields,
		timeMode: z.enum(["today", "tomorrow", "absolute"]),
		absoluteDate: isoDate.optional(),
	})
	.strict()
	.refine(
		(s) => (s.timeMode === "absolute") === (s.absoluteDate !== undefined),
		"absolute_date_only_for_absolute",
	);
export const quoteSpec = z
	.object({
		...common,
		purpose: z.literal("quote"),
		target: quoteTarget,
		requiredFields: z
			.array(z.enum(quoteFields))
			.length(quoteFields.length)
			.refine((a) => a.every((v, i) => v === quoteFields[i]), "fixed_fields"),
		timeMode: z.literal("latest"),
	})
	.strict();
export const searchSpec = z.union([weatherSpec, quoteSpec]);
export type WeatherSpec = z.infer<typeof weatherSpec>;
export type QuoteSpec = z.infer<typeof quoteSpec>;
export type SearchSpec = WeatherSpec | QuoteSpec;
export type BuiltSpec =
	| { kind: "matched"; spec: SearchSpec; key: string; canonicalJson: string }
	| { kind: "ambiguous"; reason: string }
	| { kind: "unsupported"; reason: string };

export const requestBinding = z
	.object({
		specDigest: hex64,
		requestAtMs: z.number().int().nonnegative(),
		expectedDate: isoDate.nullable(),
		validationPolicyVersion: z.number().int().positive(),
	})
	.strict();
export type RequestBinding = z.infer<typeof requestBinding>;

// ---------- recipe ----------
export const validationProfile = z.enum([
	"weather-json-v1",
	"weather-excerpt-v1",
	"quote-json-v1",
	"quote-excerpt-v1",
]);
export const routeRecipe = z
	.object({
		toolId: z.enum(["web.read", "web.forecast", "web.quote"]),
		arguments: z.record(z.string(), z.unknown()),
		sourceUrl: z.string().url().max(2048),
		specDigest: hex64,
		validationProfile,
		singleSource: z.literal(true),
	})
	.strict();
export type RouteRecipe = z.infer<typeof routeRecipe>;

// ---------- lookup ----------
export type RouteFence = {
	key: string;
	epoch: number;
	incarnation: string;
	generation: number;
};
export type RouteLookup =
	| {
			kind: "direct";
			versionId: string;
			recipe: RouteRecipe;
			fence: RouteFence;
	  }
	| { kind: "candidate"; candidateDigest: string; fence: RouteFence }
	| {
			kind: "lookup";
			reason:
				| "new_key"
				| "no_candidate"
				| "expired"
				| "source_failure"
				| "rediscover"
				| "policy_changed"
				| "capacity";
			fence: RouteFence | null;
	  }
	| { kind: "disabled" }
	| { kind: "unavailable"; code: string };
export const lookupHit = z
	.object({
		url: z.string().url().max(2048),
		title: z.string().max(200),
		snippet: z.string().max(400),
	})
	.strict();
export type LookupHit = z.infer<typeof lookupHit>;
export const lookupProvenance = z
	.object({
		runId: z.string().min(1),
		stepId: z.string().min(1),
		query: z.string().min(1).max(limits.keywordsMax),
		searchedAt: z.number().int().nonnegative(),
		provider: z.string().min(1).max(64),
		digest: hex64,
		origin: z.enum(["lookup", "candidate-cache"]),
	})
	.strict();
export type LookupProvenance = z.infer<typeof lookupProvenance>;

// ---------- facts ----------
export const weatherConditions = [
	"clear",
	"cloudy",
	"rain",
	"snow",
	"thunder",
	"fog",
] as const;
export const evidence = z
	.object({
		sourceId: z.string().min(1).max(128),
		quote: z.string().min(1).max(limits.evidenceChars),
	})
	.strict();
export const weatherFacts = z
	.object({
		purpose: z.literal("weather"),
		location: weatherTarget,
		targetDate: isoDate,
		timeZone: z.string().min(1).max(64),
		condition: z.enum(weatherConditions),
		maxTemp: z.number().min(-90).max(70).optional(),
		minTemp: z.number().min(-90).max(70).optional(),
		unit: z.literal("C"),
		announcedAt: isoDateTime,
		evidence: z.array(evidence).min(1).max(4),
	})
	.strict();
export const quoteFacts = z
	.object({
		purpose: z.literal("quote"),
		ticker: quoteTarget.shape.ticker,
		market: z.string().min(1).max(16),
		currency: z.string().regex(/^[A-Z]{3}$/),
		priceKind: z.literal("regular"),
		price: z.number().positive().finite(),
		priceAt: isoDateTime,
		timeZone: z.string().min(1).max(64),
		evidence: z.array(evidence).min(1).max(4),
	})
	.strict();
export const routeFacts = z
	.discriminatedUnion("purpose", [weatherFacts, quoteFacts])
	.refine(
		(v) =>
			new TextEncoder().encode(JSON.stringify(v)).length <= limits.factsBytes,
		"facts_too_large",
	);
export type RouteFacts = z.infer<typeof routeFacts>;

/** What the host passes: only fields the validator needs from tool results. */
export type VisibleSource = {
	sourceId: string;
	url: string;
	body: string;
	basis: string;
	fetchedAt: string;
	truncated: boolean;
};
export type CanonicalReportPatch = {
	summary: string;
	claims: { text: string; evidence: { sourceId: string; quote: string }[] }[];
	limitations: string[];
};
export type SafeProjection = {
	summary: string;
	claims: { text: string; sourceIds: string[] }[];
	limitations: string[];
};
export type ObservationResult =
	| {
			kind: "valid";
			proofId: string | null;
			canonicalReportPatch: CanonicalReportPatch;
			projection: SafeProjection;
			projectionDigest: string;
	  }
	| { kind: "source_unusable"; code: string }
	| { kind: "report_invalid"; code: string }
	| { kind: "policy_unavailable"; code: string };

// ---------- state / drafts ----------
export type RouteState =
	| "unregistered"
	| "preparing"
	| "active"
	| "suspended"
	| "expired"
	| "disabled";
export const draftStates = [
	"queued",
	"authoring",
	"reviewing",
	"activated",
	"rejected",
	"interrupted",
	"superseded",
] as const;
export type DraftState = (typeof draftStates)[number];
export const terminalDraftStates: readonly DraftState[] = [
	"activated",
	"rejected",
	"interrupted",
	"superseded",
];
export const isTerminalDraft = (s: DraftState) =>
	terminalDraftStates.includes(s);
export const draftOrigin = z.enum(["adoption", "edit"]);
export const authorStep = z.enum([
	"author-1",
	"author-2",
	"review-1",
	"review-2",
]);
export type AuthorStep = z.infer<typeof authorStep>;
export const jobPayload = z
	.object({ draftId: uuid, step: authorStep })
	.strict();
export type JobPayload = z.infer<typeof jobPayload>;

export const authorOutput = z
	.object({
		name: z.string().min(1).max(64),
		description: z.string().min(1).max(256),
		body: z.string().min(1),
		contextRule: z.string().min(1),
		recipe: routeRecipe,
	})
	.strict();
export type AuthorOutput = z.infer<typeof authorOutput>;
export const reviewCodes = [
	"schema",
	"scope",
	"policy_conflict",
	"instruction_injection",
	"context_overflow",
	"unsupported",
] as const;
export const reviewOutput = z
	.object({
		decision: z.enum(["approved", "rejected"]),
		code: z.enum(reviewCodes).nullable(),
		problems: z.array(z.string().min(1).max(300)).max(8),
		draftDigest: hex64,
	})
	.strict()
	.refine(
		(r) =>
			r.decision === "approved"
				? r.code === null && r.problems.length === 0
				: r.code !== null && r.problems.length >= 1,
		"review_shape",
	);
export type ReviewOutput = z.infer<typeof reviewOutput>;

// ---------- DTOs / API ----------
export const draftStatus = z
	.object({
		id: uuid,
		state: z.enum(draftStates),
		errorCode: z.string().nullable(),
	})
	.strict();
export type DraftStatus = z.infer<typeof draftStatus>;
export type RouteSummaryDTO = {
	key: string;
	keywords: string;
	target: WeatherSpec["target"] | QuoteSpec["target"];
	state: RouteState;
	stateToken: string;
	activeVersionId: string | null;
	sourceUrl: string | null;
	lastSuccessAt: number | null;
	draftStatus: DraftStatus | null;
};
export type RouteDTO = RouteSummaryDTO & {
	skillRevision: {
		revisionId: string;
		hash: string;
		body: string | null;
	} | null;
	contextProjection: string | null;
};
export const keyParam = z.string().regex(/^[0-9a-f]{64}$/);
export const listQuery = z
	.object({
		cursor: z.string().max(limits.cursorBytes).optional(),
		limit: z.coerce
			.number()
			.int()
			.min(1)
			.max(limits.listLimitMax)
			.default(limits.listLimitMax),
	})
	.strict();
export const cursorPayload = z
	.object({
		lastKey: hex64,
		epoch: z.number().int().nonnegative(),
		scope: z.string().min(1),
	})
	.strict();
export const editBody = z
	.object({
		requestId: uuid,
		expectedStateToken: hex64,
		instruction: z.string().min(1).max(limits.instructionMax),
	})
	.strict();
export const controlBody = z
	.object({ requestId: uuid, expectedStateToken: hex64 })
	.strict();
export const clearBody = z
	.object({ requestId: uuid, expectedEpoch: z.number().int().nonnegative() })
	.strict();
export type ListResponse = {
	items: RouteSummaryDTO[];
	nextCursor: string | null;
	epoch: number;
};
export type ClearResponse = { epoch: number; deletedKeys: number };
export type EditResponse = { draftId: string };

export const bytesOf = (v: unknown) =>
	new TextEncoder().encode(typeof v === "string" ? v : JSON.stringify(v))
		.length;
export const sha256 = (v: unknown) =>
	new Bun.CryptoHasher("sha256")
		.update(typeof v === "string" ? v : JSON.stringify(v))
		.digest("hex");
/** Canonical JSON: all object keys sorted, array order preserved. */
export function canonicalJson(value: unknown): string {
	const norm = (v: unknown): unknown =>
		Array.isArray(v)
			? v.map(norm)
			: v && typeof v === "object"
				? Object.fromEntries(
						Object.entries(v as Record<string, unknown>)
							.filter(([, x]) => x !== undefined)
							.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
							.map(([k, x]) => [k, norm(x)]),
					)
				: v;
	return JSON.stringify(norm(value));
}
