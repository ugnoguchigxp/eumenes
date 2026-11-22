import type { Database } from "bun:sqlite";
import { z } from "zod";
import type { HandlerDefinition } from "../../queue";
import type { Run } from "../contracts";
import { linkAnswer } from "../repository";
import {
	GENERATE_KIND,
	type DialogueDeps,
	type GeneratePayload,
} from "./context";

/**
 * A forget that names no short reference is settled by the agency after the run that asked it (the memory
 * architecture redesign, section 5.2): until it is, what it will exclude is still in the next prompt. So the
 * conversation's generations wait for it, and the agency says when it has settled (`targetsSettled`): no fixed wait.
 *
 * Two parts. The hold job is queued with the request, behind the conversation's own jobs (same concurrency key), and
 * ends when nothing of the conversation is pending. A generation that is claimed while something is pending is not
 * started: it is queued again behind the hold job (`parkGenerationInTransaction`).
 */
export const TARGETS_HOLD_KIND = "dialogue.targets_hold";
/** The longest a settlement may take before the generations go on without it (the agency's call is far shorter). */
export const TARGETS_HOLD_MS = 2 * 60 * 1000;

type HoldPayload = { conversationId: string };
type Claim<P> = Parameters<
	HandlerDefinition<P, unknown, unknown>["prepareInTransaction"]
>[1];

/** The agency's word that it settled what it was given, and the hold jobs waiting for it. */
export function createTargetsGate() {
	const waiting = new Map<string, Set<() => void>>();
	return {
		/** Waits until `settled(conversationId)` (or the signal). */
		wait(conversationId: string, signal: AbortSignal): Promise<void> {
			return new Promise((resolve) => {
				const wake = () => {
					waiting.get(conversationId)?.delete(wake);
					signal.removeEventListener("abort", wake);
					resolve();
				};
				const set = waiting.get(conversationId) ?? new Set();
				set.add(wake);
				waiting.set(conversationId, set);
				if (signal.aborted) wake();
				else signal.addEventListener("abort", wake, { once: true });
			});
		},
		settled(conversationId: string) {
			for (const wake of waiting.get(conversationId) ?? []) wake();
		},
	};
}
export type TargetsGate = ReturnType<typeof createTargetsGate>;

/** Queues the hold job of a forget that waits for its target (in the transaction that kept the request). */
export function holdForTargetsInTransaction(
	deps: DialogueDeps,
	tx: Database,
	conversationId: string,
	requestId: string,
) {
	deps.queue.enqueueInTransaction(tx, {
		scope: "dialogue",
		kind: TARGETS_HOLD_KIND,
		dedupeKey: `targets-hold:${requestId}`,
		payload: { conversationId } satisfies HoldPayload,
		subjectRef: conversationId,
		lane: "interactive",
		concurrencyKey: `conversation:${conversationId}`,
		deadlineAtMs: Date.parse(deps.clock()) + TARGETS_HOLD_MS,
		maxAttempts: 1,
	});
}

export function createTargetsHoldHandler(
	deps: DialogueDeps,
	gate: TargetsGate,
): HandlerDefinition<HoldPayload, HoldPayload, void> {
	const pending = (conversationId: string) =>
		deps.store.read(
			(db) =>
				deps.steward?.hasPendingForgetInTransaction(db, conversationId) ??
				false,
		);
	return {
		kind: TARGETS_HOLD_KIND,
		payloadVersions: [1],
		schema: z.object({ conversationId: z.string() }),
		recovery: "replay_safe",
		prepareInTransaction: (_tx, claim: Claim<HoldPayload>) => ({
			status: "ready",
			input: claim.payload,
		}),
		async execute({ conversationId }, { signal }) {
			while (!signal.aborted && pending(conversationId))
				await gate.wait(conversationId, signal);
		},
		settleInTransaction: () => "applied",
		cancelInTransaction: () => undefined,
	};
}

/**
 * A generation claimed while a forget of its conversation is pending does not start: its run is queued again behind
 * the hold job (the same concurrency key, later in the queue), whole, with its payload. True when it was parked.
 */
export function parkGenerationInTransaction(
	deps: DialogueDeps,
	tx: Database,
	run: Run,
	claim: Claim<GeneratePayload>,
): boolean {
	if (!deps.steward?.hasPendingForgetInTransaction(tx, run.conversationId))
		return false;
	// Only behind a hold job still to run: one that ended (its time was up) lets the generations go on.
	const holding = (["queued", "running", "retry_wait"] as const).some((state) =>
		deps.queue
			.listByKindInTransaction(tx, TARGETS_HOLD_KIND, state, 50, "dialogue")
			.some((job) => job.subjectRef === run.conversationId),
	);
	if (!holding) return false;
	const { job } = deps.queue.enqueueInTransaction(tx, {
		scope: "dialogue",
		kind: GENERATE_KIND,
		dedupeKey: `parked:${claim.jobId}`,
		payload: claim.payload,
		subjectRef: run.id,
		lane: "interactive",
		resourceKey: "inference.llm",
		maxAttempts: 1,
		concurrencyKey: `conversation:${run.conversationId}`,
		deadlineAtMs: Date.parse(run.deadlineAt!),
	});
	linkAnswer(tx, run.id, job.id);
	return true;
}
