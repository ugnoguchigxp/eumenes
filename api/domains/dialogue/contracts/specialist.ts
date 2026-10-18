import type { Database } from "bun:sqlite";
import { z } from "zod";

/**
 * Specialist sessions (spec toolchain-specialist-dialogue 2026-10-17 §4). After the conversation
 * hands over to a session toolchain, every utterance of that conversation goes to the specialist
 * directly until it returns. Dialogue owns the session, its addressee and its only expiry; the
 * toolchain's domain owns the work through the application-implemented `SpecialistPort`.
 */

const specialistStates = ["active", "suspended", "closing", "ended"] as const;
export type SpecialistState = (typeof specialistStates)[number];
const specialistEndReasons = [
	"closed",
	"discarded",
	"returned",
	"expired",
	"restarted",
	"revoked",
] as const;
export type SpecialistEndReason = (typeof specialistEndReasons)[number];

const specialistSessionSchema = z.object({
	id: z.string(),
	conversationId: z.string(),
	toolchainId: z.string(),
	toolchainRevisionId: z.string(),
	/** The toolchain's display title (who the user is talking to). */
	title: z.string(),
	artifactRevisionId: z.string(),
	adapterRef: z.string(),
	workRef: z.string(),
	state: z.enum(specialistStates),
	endReason: z.enum(specialistEndReasons).nullable(),
	/** Advances on every state change; clients send it back as `expectedRevision`. */
	revision: z.number().int(),
	/**
	 * Advances when the addressee is addressed anew: at start and when suspended work resumes. A return
	 * leaves the epoch as it is and ends the active state, so a send aimed at the session is refused.
	 */
	epoch: z.number().int(),
	activeRunId: z.string().nullable(),
	/** The work's unsaved/busy state as the domain reports it now. */
	dirty: z.boolean(),
	busy: z.boolean(),
	label: z.string(),
	expiresAt: z.string(),
	/** Set while a switch to another target waits for the user's decision (spec §4.4). */
	pendingSwitch: z
		.object({
			toolchainId: z.string(),
			targetRef: z.string().nullable(),
			workRevision: z.number().int(),
		})
		.nullable(),
	createdAt: z.string(),
	updatedAt: z.string(),
});
export type SpecialistSession = z.infer<typeof specialistSessionSchema>;

/** `GET /api/conversations/:id/specialist`: the live (non-ended) session or null. */
export const specialistSessionResponseSchema = z.object({
	session: specialistSessionSchema.nullable(),
});

/**
 * `POST /api/specialist-sessions/:id/{return,resume,discard,close}` from the screen. `return`
 * suspends a dirty work (ends a clean one), `close` refuses unsaved work with `work_unsaved`,
 * `discard` drops the draft. A repeated `requestId` returns the first result.
 */
export const specialistCommandSchema = z
	.object({ requestId: z.uuid(), expectedRevision: z.number().int().min(0) })
	.strict();
export type SpecialistCommand = z.infer<typeof specialistCommandSchema>;
/**
 * `POST /api/specialist-sessions/:id/retarget` from the screen: the active session goes on with the
 * saved item the user chose in the history. Its own work is ended and a session on that item opens; unsaved
 * work is refused with `work_unsaved` unless the user chose to discard it.
 */
export const specialistRetargetSchema = specialistCommandSchema
	.extend({
		targetRef: z.string().min(1).max(64),
		discardUnsaved: z.boolean(),
	})
	.strict();
export type SpecialistRetarget = z.infer<typeof specialistRetargetSchema>;
export const specialistCommandKinds = [
	"return",
	"resume",
	"discard",
	"close",
] as const;
export type SpecialistCommandKind = (typeof specialistCommandKinds)[number];

/**
 * Optional submit context: the saved item the user is looking at, as the screen got it from a
 * host source. The host re-checks it against the toolchain's issued choices before any use.
 */
export const viewingSchema = z
	.object({
		artifactRevisionId: z.string().min(1).max(200),
		targetRef: z.string().min(1).max(200),
	})
	.strict();
export type Viewing = z.infer<typeof viewingSchema>;

/**
 * Optional submit context: the addressee the screen showed when the user sent (spec §8). The host
 * refuses with `addressee_changed` when the conversation's addressee differs now, so an utterance
 * never silently goes to another agent; the screen keeps the text for the user to confirm.
 * `sessionId: null` means the main agent.
 */
export const addresseeSchema = z
	.object({
		sessionId: z.string().min(1).max(200).nullable(),
		epoch: z.number().int().min(0).nullable(),
	})
	.strict();
export type Addressee = z.infer<typeof addresseeSchema>;

/** The resolved session toolchain the specialist runs with (fixed at session start). */
export type SpecialistSet = {
	toolchainId: string;
	toolchainRevisionId: string;
	title: string;
	bindingRevisionId: string;
	adapterRef: string;
	artifactRevisionId: string;
	packageRevisionId: string;
	profile: string;
	skills: string[];
	tools: Array<{
		id: string;
		toolRevisionId: string;
		operationName: string;
		inputSchemaRef: string;
		summary: string;
		schema: Record<string, unknown>;
	}>;
	/** Schema whose choices list startable saved items; null when sessions start empty only. */
	targetSchemaRef: string | null;
	/** The binding's time limits (run from the hand-over, one turn, one inference); null: the host defaults. */
	timeLimits: { runMs: number; turnMs: number; inferenceMs: number } | null;
};

type SpecialistWorkState = {
	workRef: string;
	savedRef: string | null;
	dirty: boolean;
	busy: boolean;
	revision: number;
	label: string;
	current: unknown;
};

/**
 * Application-implemented access to session toolchains and their domain work. Dialogue never
 * names a domain: everything goes through the binding's adapter.
 */
export interface SpecialistPort {
	/** Throws `capability_unavailable` when the toolchain is not a usable session toolchain. */
	setInTransaction(db: Database, toolchainRevisionId: string): SpecialistSet;
	/**
	 * Saved items a session may start from (host-issued refs, at most 50). A valid `include` ref (the
	 * item the user is viewing) is always among them, even when older than the 20 most recent.
	 */
	targetChoicesInTransaction(
		db: Database,
		set: SpecialistSet,
		include?: string | null,
	): Array<{ ref: string; label: string }>;
	openWorkInTransaction(
		db: Database,
		set: SpecialistSet,
		input: { sessionId: string; targetRef: string | null },
	): SpecialistWorkState;
	workStateInTransaction(
		db: Database,
		adapterRef: string,
		workRef: string,
	): SpecialistWorkState | null;
	beginTurnInTransaction(
		db: Database,
		adapterRef: string,
		workRef: string,
		runId: string,
	): void;
	endTurnInTransaction(
		db: Database,
		adapterRef: string,
		workRef: string,
		runId: string,
	): void;
	endWorkInTransaction(
		db: Database,
		adapterRef: string,
		workRef: string,
		mode: "discard" | "close",
	): void;
	/**
	 * Validate the model's arguments for one tool of the set against its registered schema. A schema
	 * failure carries `detail`: at most 8 lines of path, kind and expected type (never an input value).
	 */
	parseInvocation(
		set: SpecialistSet,
		toolId: string,
		args: unknown,
	):
		| { ok: true; operationName: string; input: Record<string, unknown> }
		| { ok: false; code: string; detail?: string[] };
	/**
	 * Run one tool operation for the turn holding the work. Returns the short projection the
	 * specialist sees next (never the full receipt); throws a safe `/^[a-z_]+$/` code on refusal.
	 */
	invokeInTransaction(
		db: Database,
		set: SpecialistSet,
		input: {
			operationName: string;
			input: Record<string, unknown>;
			requestId: string;
			sessionId: string;
			runId: string;
			conversationId: string;
			workRef: string;
		},
	): { answerContext: unknown };
	/** Wake the adapter after the writer transaction committed. */
	afterCommit(adapterRef: string): void;
}
