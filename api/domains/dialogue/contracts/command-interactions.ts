import { z } from "zod";
import { schemaRefPattern } from "../../capabilities/contracts";

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

/** The generic question schema; every binding allows it. */
export const ANSWER_TEXT_SCHEMA = "builtin:answerText";

export const interactionQuestion = z.strictObject({
	questionId: z.uuid(),
	prompt: z.string().min(1).max(500),
	/** A registered schema ref; the binding of the chain decides which ones it may ask. */
	inputSchemaRef: z.string().regex(schemaRefPattern),
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

/** Answer accepted: the resumed run the host enqueued in the same transaction. */
export type InteractionAnswerResult = {
	interaction: InteractionView;
	runId: string;
	replay: boolean;
};
