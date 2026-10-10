import { z } from "zod";

/**
 * The grounded claim list and the correction screen (P5-02).
 *
 * Everything the screen shows is DATA read from the World ledger; nothing here
 * writes a claim by itself. A change is a request that carries the revision
 * the person saw (`expectedRevision`); the host maps it to a World operation
 * and the ledger answers. There is no graph and no edge editing.
 */

/** Adoption state: the claim's lifecycle, never mixed with freshness or evidence. */
export const CLAIM_ADOPTIONS = ["adopted", "disputed", "candidate"] as const;
export type ClaimAdoption = (typeof CLAIM_ADOPTIONS)[number];

/** Where the claim came from (World's `origin`). */
export const CLAIM_ORIGINS = [
	"runtime_observation",
	"user_report",
	"document_claim",
	"model_hypothesis",
] as const;
export type ClaimOrigin = (typeof CLAIM_ORIGINS)[number];

export const EVIDENCE_KINDS = [
	"user_statement",
	"document",
	"runtime_measurement",
	"assistant_summary",
] as const;
export type ClaimEvidenceKind = (typeof EVIDENCE_KINDS)[number];

export const CLAIM_FRESHNESS = ["fresh", "stale", "unknown"] as const;
export type ClaimFreshness = (typeof CLAIM_FRESHNESS)[number];

/**
 * How a claim may be STYLED. Only `adopted` (the person's report or a
 * document, adopted) is the confirmed style: a model hypothesis (even adopted)
 * and a measured result are different tones, and an unadopted claim is a
 * candidate whatever its origin.
 */
export const CLAIM_TONES = [
	"adopted",
	"measured",
	"hypothesis",
	"candidate",
	"disputed",
] as const;
export type ClaimTone = (typeof CLAIM_TONES)[number];

export function claimTone(
	adoption: ClaimAdoption,
	origin: ClaimOrigin,
	evidenceKinds: readonly ClaimEvidenceKind[],
): ClaimTone {
	if (adoption === "candidate") return "candidate";
	if (adoption === "disputed") return "disputed";
	if (origin === "model_hypothesis") return "hypothesis";
	if (
		origin === "runtime_observation" ||
		evidenceKinds.includes("runtime_measurement")
	)
		return "measured";
	return "adopted";
}

export const typedValueSchema = z.union([
	z.strictObject({ kind: z.literal("string"), value: z.string() }),
	z.strictObject({ kind: z.literal("boolean"), value: z.boolean() }),
	z.strictObject({
		kind: z.literal("number"),
		value: z.number().finite(),
		unit: z.string(),
	}),
	z.strictObject({ kind: z.literal("entity"), entityId: z.string() }),
]);
export type ClaimValue = z.infer<typeof typedValueSchema>;

/** A claim's content: a value, or a relation to another target. */
export const claimContentSchema = z.union([
	z.strictObject({ kind: z.literal("value"), value: typedValueSchema }),
	z.strictObject({
		kind: z.literal("relation"),
		relation: z.string(),
		objectId: z.string(),
	}),
]);
export type ClaimContent = z.infer<typeof claimContentSchema>;

/** One row of the list. Target, claim, adoption, evidence kind and freshness are SEPARATE fields. */
export const claimRowSchema = z.strictObject({
	id: z.string(),
	revision: z.number().int().min(1),
	target: z.strictObject({ subjectId: z.string() }),
	claim: z.strictObject({
		predicate: z.string(),
		content: claimContentSchema,
	}),
	adoption: z.enum(CLAIM_ADOPTIONS),
	origin: z.enum(CLAIM_ORIGINS),
	evidenceKinds: z.array(z.enum(EVIDENCE_KINDS)),
	freshness: z.enum(CLAIM_FRESHNESS),
	tone: z.enum(CLAIM_TONES),
});
export type ClaimRow = z.infer<typeof claimRowSchema>;

export const scopeChoiceSchema = z.strictObject({ scopeKey: z.string() });

export const claimListSchema = z.strictObject({
	scopeKey: z.string(),
	/** Only the Scopes this caller may use. */
	scopes: z.array(scopeChoiceSchema),
	asOf: z.number(),
	/** False: a read budget stopped the list. Absence is NOT "no such claim". */
	complete: z.boolean(),
	/** Claims stopped because a source they stand on changed: not shown, not usable. */
	stopped: z.number().int().min(0),
	items: z.array(claimRowSchema),
});
export type ClaimList = z.infer<typeof claimListSchema>;

const evidenceViewSchema = z.strictObject({
	evidenceId: z.string(),
	kind: z.enum(EVIDENCE_KINDS),
	stance: z.enum(["supports", "refutes"]),
	source: z.strictObject({
		namespace: z.string(),
		kind: z.string(),
		id: z.string(),
		revision: z.string(),
	}),
	rootEvidenceId: z.string(),
	seriesId: z.string().optional(),
});
export type EvidenceView = z.infer<typeof evidenceViewSchema>;

export const CONDITION_STATES = ["satisfied", "violated", "unknown"] as const;

export const claimDetailSchema = z.strictObject({
	claim: claimRowSchema,
	scopeKey: z.string(),
	asOf: z.number(),
	recordedAt: z.number(),
	condition: z.strictObject({
		kind: z.enum(["unspecified", "explicitly_unconditional", "expression"]),
		/** Human readable form of the condition expression. */
		text: z.string(),
		/** Without observations a condition stays `unknown`; it is never assumed true. */
		evaluation: z.enum(CONDITION_STATES),
		reasons: z.array(z.string()),
	}),
	supports: z.array(evidenceViewSchema),
	refutations: z.strictObject({
		evidence: z.array(evidenceViewSchema),
		claims: z.array(
			z.strictObject({
				id: z.string(),
				revision: z.number().int(),
				subjectId: z.string().optional(),
				predicate: z.string().optional(),
				adoption: z.enum(CLAIM_ADOPTIONS).optional(),
			}),
		),
	}),
	sources: z.array(
		z.strictObject({
			namespace: z.string(),
			kind: z.string(),
			id: z.string(),
			citedRevision: z.string(),
			/** current: the cited revision is the current one. changed: it moved on. unavailable: gone or not usable. */
			state: z.enum(["current", "changed", "unavailable"]),
		}),
	),
	history: z.array(
		z.strictObject({
			revision: z.number().int(),
			lifecycle: z.string(),
			origin: z.enum(CLAIM_ORIGINS),
			recordedAt: z.number(),
			content: claimContentSchema,
		}),
	),
	historyTruncated: z.boolean(),
});
export type ClaimDetail = z.infer<typeof claimDetailSchema>;

/** Forgetting, as honestly as the ledger can tell. Only `complete` means done. */
export const FORGET_DISPLAYS = [
	"pending",
	"awaiting_confirmation",
	"abandoned",
	"complete",
] as const;
export type ForgetDisplay = (typeof FORGET_DISPLAYS)[number];

export const forgetViewSchema = z.strictObject({
	forgetId: z.string(),
	display: z.enum(FORGET_DISPLAYS),
	state: z.string(),
	/** Opaque reason the last advance stopped, if any. */
	blocked: z.string().nullable(),
	abandoned: z.strictObject({
		parts: z.number().int(),
		roots: z.number().int(),
	}),
	origin: z.string(),
	rootCount: z.number().int(),
	createdAt: z.number(),
	updatedAt: z.number(),
});
export type ForgetView = z.infer<typeof forgetViewSchema>;

export const forgetListSchema = z.strictObject({
	scopeKey: z.string(),
	forgets: z.array(forgetViewSchema),
});
export type ForgetList = z.infer<typeof forgetListSchema>;

export const worldClaimsStatusSchema = z.strictObject({
	mode: z.enum(["protect", "on"]),
	enabled: z.boolean(),
	usable: z.boolean(),
	/** False while a restore or an unfinished forget keeps the Scope closed. */
	gateOpen: z.boolean(),
	scopes: z.array(scopeChoiceSchema),
});
export type WorldClaimsStatus = z.infer<typeof worldClaimsStatusSchema>;

const id = z.string().min(1).max(256);
const requestId = z.string().uuid();
const target = z.union([
	z.strictObject({ claimId: id }),
	z.strictObject({ subjectId: id, predicate: id }),
]);
const base = {
	scopeKey: id.optional(),
	/** One per user action: a double submit is the same request. */
	requestId,
	/** The revision the person saw. A different current revision is a conflict. */
	expectedRevision: z.number().int().min(1),
	target,
};
/** The statement that makes the change explicit: a confirmed message of the person. */
const reasonMessageId = id;

export const correctClaimSchema = z.strictObject({
	...base,
	reasonMessageId,
	value: z.union([
		z.strictObject({ kind: z.literal("string"), value: z.string().min(1) }),
		z.strictObject({ kind: z.literal("boolean"), value: z.boolean() }),
		z.strictObject({
			kind: z.literal("number"),
			value: z.number().finite(),
			unit: z.string(),
		}),
	]),
});
export type CorrectClaim = z.infer<typeof correctClaimSchema>;

export const retractClaimSchema = z.strictObject({
	...base,
	reasonMessageId,
});
export type RetractClaim = z.infer<typeof retractClaimSchema>;

export const forgetClaimSchema = z.strictObject(base);
export type ForgetClaim = z.infer<typeof forgetClaimSchema>;

/** The change was written to the ledger. */
export const claimAppliedSchema = z.strictObject({
	status: z.literal("applied"),
	claimId: z.string(),
});
/** The target was not one claim: the person picks, nothing was changed. */
export const claimUnresolvedSchema = z.strictObject({
	status: z.literal("unresolved"),
	candidates: z.array(claimRowSchema),
});
export const claimChangeSchema = z.union([
	claimAppliedSchema,
	claimUnresolvedSchema,
]);
export type ClaimChange = z.infer<typeof claimChangeSchema>;

export const forgetAcceptedSchema = z.union([
	z.strictObject({ status: z.literal("accepted"), forget: forgetViewSchema }),
	claimUnresolvedSchema,
]);
export type ForgetAccepted = z.infer<typeof forgetAcceptedSchema>;

/** Error codes (`{ error }` bodies). `not_found` also covers every refusal of access. */
export const WORLD_CLAIM_ERRORS = [
	"not_found",
	"world_disabled",
	"world_unavailable",
	"revision_conflict",
	"invalid_world_request",
	"reason_source_unavailable",
	"claim_not_changeable",
] as const;
export type WorldClaimError = (typeof WORLD_CLAIM_ERRORS)[number];
