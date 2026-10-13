import { z } from "zod";

/**
 * One operation's question and answer (spec §7). Dialogue owns the interaction: the question the
 * command sub-agent asked, the answers, and the frozen chain/package/binding/artifact refs the
 * resumed run must use. It is not a general task state machine.
 */
export const interactionStatuses = [
	"waiting_input",
	"ready",
	"invoking",
	"completed",
	"cancelled",
	"expired",
	"indeterminate",
] as const;
export type InteractionStatus = (typeof interactionStatuses)[number];

/** Initial proposal values (§7); measured by the capacity tests, not existing limits. */
export const INTERACTION_POLICY = {
	answerTtlMs: 24 * 60 * 60 * 1000,
	maxQuestions: 3,
	maxOpen: 256,
	maxTotal: 4096,
	maxBodyBytes: 16_384,
	bodyRetentionMs: 30 * 24 * 60 * 60 * 1000,
	tombstoneRetentionMs: 30 * 24 * 60 * 60 * 1000,
} as const;

/** Registered question schemas. The model never defines a new schema. */
export const questionSchemaRefs = [
	"builtin:answerText",
	"builtin:timerDurationAnswer",
	"builtin:timerTargetAnswer",
] as const;

/**
 * Question schemas whose answer must be one of the host-issued choices, and the answer field
 * that names the chosen ref. Without choices such a question falls back to `builtin:answerText`.
 */
export const choiceQuestionFields = {
	"builtin:timerTargetAnswer": "timerId",
} as const satisfies Partial<
	Record<(typeof questionSchemaRefs)[number], string>
>;

export const interactionQuestion = z.strictObject({
	questionId: z.uuid(),
	prompt: z.string().min(1).max(500),
	inputSchemaRef: z.enum(questionSchemaRefs),
	revision: z.number().int().min(0),
	expiresAt: z.iso.datetime({ offset: true }),
	/** For target selection: the host-issued choices (id + label), never model text. */
	choices: z
		.array(
			z.strictObject({ ref: z.string().max(64), label: z.string().max(120) }),
		)
		.max(20)
		.optional(),
});
export type InteractionQuestion = z.infer<typeof interactionQuestion>;

export type InteractionView = {
	id: string;
	conversationId: string;
	status: InteractionStatus;
	revision: number;
	chainRevisionId: string;
	artifactRevisionId: string | null;
	question: InteractionQuestion | null;
	questionCount: number;
	/** The settled common result reference once the operation completed. */
	receiptRef: { owner: string; operationId: string; digest: string } | null;
	expiresAt: string;
	createdAt: string;
	updatedAt: string;
};

/** `POST /api/toolchain-interactions/:id/answers` (UI and natural-language answers alike). */
export const interactionAnswer = z.strictObject({
	eventId: z.uuid(),
	questionId: z.uuid(),
	expectedRevision: z.number().int().min(0),
	input: z.unknown(),
});
export type InteractionAnswer = z.infer<typeof interactionAnswer>;

export const interactionCancel = z.strictObject({
	eventId: z.uuid(),
	expectedRevision: z.number().int().min(0),
});

/** Answer accepted: the resumed run the host enqueued in the same transaction. */
export type InteractionAnswerResult = {
	interaction: InteractionView;
	runId: string;
	replay: boolean;
};
