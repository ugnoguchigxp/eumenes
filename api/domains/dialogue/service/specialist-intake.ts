import type { Database } from "bun:sqlite";
import type { Addressee } from "../contracts";
import { liveSession, type SessionRecord } from "../repository";
import type { DialogueDeps } from "./context";
import { endOrMarkClosing, sessionExpired } from "./specialist-core";

/**
 * The session an utterance of this conversation is addressed to (null: the main agent takes it). Only an
 * active, unexpired session is addressed; an expired one is not extended: it is ended here and the utterance
 * goes the ordinary way. A suspended or closing session leaves the conversation with the main agent.
 * `cancelled` is what ending an expired session withdrew; the caller aborts it after the commit.
 */
export function addressedSession(
	deps: DialogueDeps,
	db: Database,
	conversationId: string,
	now: string,
): {
	session: SessionRecord | null;
	cancelled: { flush: string[]; runs: string[] };
} {
	const none = { flush: [], runs: [] };
	if (!deps.specialist) return { session: null, cancelled: none };
	const session = liveSession(db, conversationId);
	if (!session) return { session: null, cancelled: none };
	if (session.state !== "closing" && sessionExpired(session, now)) {
		const ended = endOrMarkClosing(deps, db, session, "expired");
		return { session: null, cancelled: ended };
	}
	return {
		session: session.state === "active" ? session : null,
		cancelled: none,
	};
}

/**
 * Whether what the screen showed when the user sent is still the conversation's addressee: the same active
 * session at the same epoch, or the main agent on both sides.
 */
export function addresseeMatches(
	addressee: Addressee,
	current: SessionRecord | null,
): boolean {
	return current
		? addressee.sessionId === current.id && addressee.epoch === current.epoch
		: addressee.sessionId === null;
}

/**
 * The run time of the session's toolchain (spec toolchain-time-limits-design 2026-10-18 §3.2) for an utterance
 * addressed to it; 0 keeps the host default, also when the toolchain cannot be read now (the turn refuses then).
 */
export function sessionRunMs(
	deps: DialogueDeps,
	db: Database,
	session: SessionRecord,
): number {
	try {
		return (
			deps.specialist?.setInTransaction(db, session.toolchainRevisionId)
				.timeLimits?.runMs ?? 0
		);
	} catch {
		return 0;
	}
}
