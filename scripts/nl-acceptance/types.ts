import { z } from "zod";

/**
 * Contracts of the natural-language UI acceptance runner (spec §10). Frozen files (cases,
 * criteria, fixtures, pilot plan) are parsed here; the evidence types are what the runner
 * records and what the judge reads. Nothing here names a selector or a click order.
 */

export const GROUPS = [
	"baseline",
	"standard",
	"variant-a",
	"variant-b",
] as const;
export type Group = (typeof GROUPS)[number];
const groupSchema = z.enum(GROUPS);

export const budgetSchema = z.strictObject({
	wallSeconds: z.number().int().positive(),
	maxActions: z.number().int().positive(),
	maxModelCalls: z.number().int().positive(),
	maxCostUSD: z.number().nonnegative(),
});
export type Budget = z.infer<typeof budgetSchema>;

export const evidenceKinds = [
	"screenshots",
	"observations",
	"actions",
	"readonly-host-state",
	"receipt-refs",
] as const;

/** Words that would turn a goal into a procedure; the case file must stay purpose-only. */
const PROCEDURAL =
	/selector|xpath|getBy[A-Z]|locator\(|\[data-|#[a-z][\w-]+|querySelector|ボタン「|クリック順|click\s/i;

/**
 * What the tester may operate. `isolated-eumenes-artifacts` is the UI-only surface: the app's
 * artifact screens without the conversation input, whose answers in the isolated fixture come
 * from a canned model rather than the product (UI and conversation cases are kept apart).
 */
export const allowedSurfaces = [
	"isolated-eumenes-browser",
	"isolated-eumenes-artifacts",
] as const;
export type AllowedSurface = (typeof allowedSurfaces)[number];

export const caseSchema = z
	.strictObject({
		caseId: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
		version: z.number().int().positive(),
		goal: z
			.string()
			.min(1)
			.max(600)
			.refine((goal) => !PROCEDURAL.test(goal), "goal_is_procedural"),
		initialStateRef: z.string().regex(/^fixture:[a-z0-9-]+@\d+$/),
		allowedSurface: z.enum(allowedSurfaces),
		criteriaRef: z.string().regex(/^criteria:[a-z0-9-]+@\d+$/),
		budget: budgetSchema,
		evidence: z.array(z.enum(evidenceKinds)).min(1),
		/** true when the case needs the real conversation LLM (`--with-product-llm`). */
		requires: z.strictObject({ productLlm: z.boolean() }),
	})
	.readonly();
export type CaseDef = z.infer<typeof caseSchema>;

const timerSeed = z.strictObject({
	label: z.string().min(1).max(80),
	durationSeconds: z.number().int().min(1).max(86400),
});
const faultSchema = z.strictObject({
	/** The request reaches the server, but the browser never sees the response. */
	kind: z.literal("drop-response"),
	method: z.literal("POST"),
	pathPattern: z.string().min(1),
	/** 1-based index among matching requests. */
	nth: z.number().int().positive(),
});
export const fixtureSchema = z
	.strictObject({
		fixtureId: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
		version: z.number().int().positive(),
		description: z.string().min(1),
		/** "fixture" = scripts/toolchain-fixture-server.ts with timers; "product" = the real server with the saved LARM. */
		stack: z.enum(["fixture", "product"]),
		/** Harness-side seeding before the tester starts; the judge sees these in the initial snapshot. */
		seedTimers: z.array(timerSeed).max(10),
		/** Harness-controlled faults. The tester is never told about them. */
		faults: z.array(faultSchema).max(5),
		expectedInitial: z.strictObject({ timers: z.number().int().min(0) }),
	})
	.readonly();
export type FixtureDef = z.infer<typeof fixtureSchema>;

export const hostReads = ["timers", "interactions"] as const;
export const criteriaSchema = z
	.strictObject({
		criteriaId: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
		version: z.number().int().positive(),
		caseId: z.string(),
		hostReads: z.array(z.enum(hostReads)).min(1),
		/** Screen texts (accessibility snapshot) that claim a completed start. A claim with no timer is a fake success. */
		successMarkers: z.array(z.string()).max(20),
		items: z
			.array(
				z.strictObject({
					id: z.string().regex(/^[A-Z][A-Z0-9-]*$/),
					statement: z.string().min(1),
					check: z.string().min(1),
					params: z.record(z.string(), z.unknown()),
					required: z.boolean(),
				}),
			)
			.min(1),
	})
	.readonly();
export type Criteria = z.infer<typeof criteriaSchema>;

export const pilotSchema = z
	.strictObject({
		pilotId: z.string(),
		version: z.number().int().positive(),
		caseId: z.string(),
		groups: z.array(groupSchema).min(1),
		runsPerGroup: z.number().int().positive(),
		totalCapUSD: z.number().positive(),
		autoRepeatUntilPass: z.literal(false),
	})
	.readonly();
export type PilotPlan = z.infer<typeof pilotSchema>;

export const lockSchema = z.strictObject({
	lockVersion: z.literal(1),
	/** Path relative to tests/acceptance/nl → sha256 of the file bytes. */
	files: z.record(z.string(), z.string().regex(/^[0-9a-f]{64}$/)),
});
export type FrozenLock = z.infer<typeof lockSchema>;

/** The only operations the tester may request: screen operations on accessibility refs. */
export const TESTER_ACTIONS = [
	"click",
	"fill",
	"press",
	"wait",
	"done",
	"give_up",
] as const;
export type TesterActionName = (typeof TESTER_ACTIONS)[number];
export type TesterAction = {
	action: TesterActionName;
	ref?: string;
	/** fill: the value; press: a key name (e.g. Enter); wait: seconds (max 15). */
	text?: string;
	reason: string;
};

export type FailureClass =
	| "product"
	| "tester"
	| "environment"
	| "criteria"
	| "undetermined";
export type Verdict = "success" | "failure" | "inconclusive";

export type Termination = {
	reason:
		| "done"
		| "give_up"
		| "budget_wall"
		| "budget_actions"
		| "budget_model_calls"
		| "budget_cost"
		| "tester_error"
		| "forbidden_action"
		| "driver_error"
		| "environment_error"
		| "precondition_failed";
	detail?: string;
};

export type HostTimer = {
	id: string;
	revision: number;
	state: "active" | "paused" | "elapsed" | "cancelled";
	label: string;
	durationSeconds: number;
	dueAt: string;
	remainingSeconds: number;
	originRunId: string | null;
};
export type HostInteraction = {
	id: string;
	status: string;
	questionCount: number;
	hasReceiptRef: boolean;
};
/** One readonly observation of the host. `atMs` is the runner clock, `serverNowMs` the server's. */
export type HostSnapshot = {
	seq: number;
	atMs: number;
	serverNowMs: number;
	timers: HostTimer[];
	interactions: HostInteraction[] | null;
};
/** A timer_action receipt seen passively in an /api response body (never injected, never replayed). */
export type ObservedReceipt = {
	atMs: number;
	action: string;
	operationId: string;
	timerId: string | null;
	revision: number | null;
	httpStatus: number;
};
export type ScreenObservation = { seq: number; atMs: number; text: string };

/** Everything the judge reads. It is serialized as evidence.json so a run can be re-judged. */
export type RunEvidence = {
	caseId: string;
	hostSeries: HostSnapshot[];
	receipts: ObservedReceipt[];
	screens: ScreenObservation[];
	/** Runner-clock times of page loads after the first. */
	reloads: number[];
	faultsTriggered: Array<{ kind: string; atMs: number }>;
	termination: Termination;
};

export type CheckStatus = "met" | "unmet" | "violated" | "unknown";
export type CriterionResult = {
	id: string;
	required: boolean;
	status: CheckStatus;
	code: string;
	detail?: string;
	/** Set on unknown results caused by the harness rather than the tester or product. */
	class?: FailureClass;
};
export type JudgeResult = {
	verdict: Verdict;
	failureClass: FailureClass | null;
	reasonCode: string;
	criteria: CriterionResult[];
	/** A failure is provisional until an independent reviewer confirms the class. */
	reviewRequired: boolean;
};
