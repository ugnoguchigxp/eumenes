import type { Database } from "bun:sqlite";
import { z } from "zod";
import { addresseeSchema, viewingSchema } from "./specialist";
const submitFields = z.object({
	requestId: z.uuid(),
	conversationId: z.string().min(1).max(120),
	text: z.string().trim().max(8000),
	presentation: z.enum(["conversation", "artifact"]).optional(),
	attachmentIds: z
		.array(z.uuid())
		.max(8)
		.refine((ids) => new Set(ids).size === ids.length)
		.optional(),
	utteranceId: z.string().min(1).max(120).optional(),
	/** The saved item on screen, as a host source issued it; re-checked against the issued choices. */
	viewing: viewingSchema.optional(),
	/** Who the screen showed as listening; a different addressee now refuses the send (`addressee_changed`). */
	addressee: addresseeSchema.optional(),
	/** The screen's own toolchain: a form submit goes straight to it, never through the main agent's selection. */
	toolchainId: z
		.string()
		.regex(/^[a-z0-9][a-z0-9.-]{0,63}$/)
		.optional(),
});
const hasInput = (v: { text: string; attachmentIds?: string[] }) =>
	!!(v.text || v.attachmentIds?.length);
/** A pinned toolchain is a screen's form submit: only an artifact presentation carries one. */
const pinnedOnScreen = (v: {
	toolchainId?: string;
	presentation?: string;
	attachmentIds?: string[];
	utteranceId?: string;
}) =>
	!v.toolchainId ||
	(v.presentation === "artifact" &&
		!v.attachmentIds?.length &&
		v.utteranceId === undefined);
export const submitSchema = submitFields
	.refine(hasInput, "input_required")
	.refine(pinnedOnScreen, "toolchain_requires_artifact");
export type Submit = z.infer<typeof submitSchema>;
/** Public HTTP input: voice runs are created only by voice-dialogue, never by clients. */
export const publicSubmitSchema = submitFields
	.omit({ utteranceId: true })
	.strict()
	.refine(hasInput, "input_required")
	.refine(pinnedOnScreen, "toolchain_requires_artifact");
export type PublicSubmit = z.infer<typeof publicSubmitSchema>;
/** The latest utterance's corrected text, answered again (the prompt edit design, section 4.1). */
export const resubmitSchema = z
	.object({ requestId: z.uuid(), text: z.string().trim().max(8000) })
	.strict();
export type Resubmit = z.infer<typeof resubmitSchema>;
export const runSchema = z.object({
	id: z.string(),
	agentTaskId: z.string().nullable().optional(),
	requestId: z.string(),
	conversationId: z.string(),
	utteranceId: z.string().nullable(),
	status: z.enum([
		"queued",
		"running",
		"completed",
		"failed",
		"cancelled",
		"interrupted",
	]),
	revision: z.number().int(),
	inputMessageId: z.string(),
	answerMessageId: z.string().nullable(),
	/** Adopted pre-delegation notice; separate from the final answer and conversation memory. */
	announcement: z.string().max(65_536).nullable().optional(),
	error: z.string().nullable(),
	jobId: z.string().nullable(),
	deadlineAt: z.string().nullable(),
	deadlineFixed: z.boolean().optional(),
	sourceKind: z.enum(["manual", "voice", "schedule", "notice"]),
	scheduleId: z.string().nullable(),
	occurrenceId: z.string().nullable(),
	/** The specialist session this run is a turn of; null for the main conversation's runs. */
	specialistSessionId: z.string().nullable(),
	/** The toolchain a screen's form submit named; the run skips the main agent's selection. */
	pinnedToolchainId: z.string().nullable().optional(),
	createdAt: z.string(),
	updatedAt: z.string(),
});
export type Run = z.infer<typeof runSchema>;
/**
 * A prompt of the system's (a scheduled prompt, or a notice such as a finished delegated task):
 * stored as a user message but never learned from, offered no toolchain, run in the background.
 */
export const isSystemPrompt = (kind: Run["sourceKind"]) =>
	kind === "schedule" || kind === "notice";
/** A notice the host asks the conversation to report on; its text is hidden from the chat. */
export const noticeSchema = z.object({
	requestId: z.string().min(1).max(200),
	conversationId: z.string().min(1).max(120),
	text: z.string().trim().min(1).max(8000),
});
export type Notice = z.infer<typeof noticeSchema>;
export const progressSchema = z.object({
	runId: z.string(),
	status: runSchema.shape.status,
	text: z.string().max(65_536),
	announcement: z.string().max(65_536).nullable().optional(),
	/** Machine-readable end reason of a failed run (never body text). */
	error: z.string().nullable().optional(),
});
export type RunProgress = z.infer<typeof progressSchema>;
export const promptTargetSchema = z.object({
	conversationId: z.string().min(1).max(120),
	text: z.string().trim().min(1).max(8000),
	deadlineMs: z.number().int().min(10_000).max(600_000).optional(),
});
export type PromptTarget = z.infer<typeof promptTargetSchema>;

/**
 * The steward as dialogue sees it (wired by the application). Called in the transaction in which a run ends,
 * after the run's exchange was recorded in memory's ledger.
 */
export type StewardRunEnd = {
	runId: string;
	conversationId: string;
	state: "completed" | "failed" | "interrupted" | "cancelled";
};
/** A memory request the conversation agent committed (section 13): queued as pending at once. */
export type StewardRequest = {
	conversationId: string;
	kind: "forget" | "remember" | "correct" | "goal" | "withdraw";
	what: string;
	detail?: string;
	/** The user's message the request comes from (its context, and the evidence of a remember or a correct). */
	sourceRef: string;
	/** The same id twice is one request: the second returns the first. */
	requestId?: string;
};
export interface StewardPort {
	runEndedInTransaction(db: Database, input: StewardRunEnd): void;
	requestInTransaction(
		db: Database,
		input: StewardRequest,
	): { id: string; replay: boolean };
}

/**
 * The World as dialogue sees it (wired by the application): only the names of the known targets this turn's
 * wording mentions, so the model can tell that World has something to look up. Dialogue never reads World's
 * content; that goes through the research sub-agent. With no port, or World unusable, no name is returned.
 */
export type WorldContextNamesInput = {
	conversationId: string;
	/** This turn's input, then the previous exchange: the wording known World targets are looked for in. */
	texts: readonly string[];
};
export interface WorldContextPort {
	/** Display names of the known targets the wording names (at most five), in the order they were found. */
	knownNamesInTransaction(
		db: Database,
		input: WorldContextNamesInput,
	): string[];
}

/**
 * The adopted goals as dialogue sees them (wired by the application, bound to the conversation's principal and
 * scopes). Dialogue knows no goals types: it renders what the port lists, in the order given.
 */
export type ContextGoalEntry = {
	goalId: string;
	/** Higher is more important. */
	priority: number;
	desiredState: string;
	revision: number;
};
export interface GoalsLayerPort {
	/** Adopted goals, priority high first, then most recently revised. Read-only. */
	adoptedForContextInTransaction(db: Database): ContextGoalEntry[];
	/** Which of the given goals still exist (any status); an absent one was forgotten. Read-only. */
	existingInTransaction(db: Database, goalIds: readonly string[]): Set<string>;
}

/**
 * What the agency layer (the background participation of eumenes-agency, wired by the application) lets the main
 * model see: what the assistant said on its own since the user's last message (runless messages are not in the
 * history) and its standing interests. Reference data, never instructions. Null when the layer is off or empty.
 */
export type AgencyContextUtterance = {
	messageId: string;
	text: string;
	/** `partial` when playback was interrupted; `text` is then only what was heard. */
	heard: "full" | "partial";
};
export type AgencyContext = {
	utterances: AgencyContextUtterance[];
	interests: string[];
};
export interface AgencyLayerPort {
	/** Read-only. Null when agency is off for this conversation or there is nothing to show. */
	recentForContextInTransaction(
		db: Database,
		conversationId: string,
	): AgencyContext | null;
}

export * from "./command-interactions";
export * from "./specialist";

export { errorReportSchema } from "./error-report";
