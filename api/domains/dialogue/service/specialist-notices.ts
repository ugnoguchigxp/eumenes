import type { Database } from "bun:sqlite";
import { withinJsonLimits } from "eumenes-collaboration";
import {
	byId,
	byRequest,
	insert,
	patchSession,
	setRunSession,
	sessionById,
	type SessionRecord,
} from "../repository";
import {
	observation,
	childReportRun,
} from "../repository/specialist-observations";
import type { DialogueDeps } from "./context";
import { specialistExecutionSource } from "./specialist-source";
import { sessionExpired } from "./specialist-core";
import { enqueueTurn } from "./specialist-start";

export function specialistAuthority(
	deps: DialogueDeps,
	db: Database,
	id: string,
) {
	const session = sessionById(db, id);
	return session && !sessionExpired(session, deps.clock())
		? {
				conversationId: session.conversationId,
				epoch: session.epoch,
				active: session.state === "active",
			}
		: null;
}

/** A browser child supplies exact text only after validating it against its observation. */
export function observationExcerpt(event: unknown): string | undefined {
	const result = event as { status?: unknown; excerpt?: unknown } | null;
	if (
		result?.status === "completed" &&
		typeof result.excerpt === "string" &&
		result.excerpt.length > 0 &&
		result.excerpt.length <= 3000
	)
		return result.excerpt;
}

/** A host observation resumes the owning session with its real original input; it creates no user message. */
export function notifySpecialist(
	deps: DialogueDeps,
	db: Database,
	input: {
		sessionId: string;
		epoch: number;
		sourceRunId: string;
		eventId: string;
		event: unknown;
	},
): boolean {
	if (
		input.event === null ||
		typeof input.event !== "object" ||
		Array.isArray(input.event) ||
		!withinJsonLimits(input.event) ||
		JSON.stringify(input.event).length > 16000 ||
		input.eventId.length > 200
	)
		throw new Error("specialist_event_capacity");
	const original = byId(db, input.sourceRunId),
		session = sessionById(db, input.sessionId);
	const source = specialistExecutionSource(
		deps,
		db,
		input.sourceRunId,
		input.sessionId,
		input.epoch,
	);
	if (
		!source ||
		!original ||
		original.specialistSessionId !== input.sessionId ||
		!session ||
		session.state !== "active" ||
		session.epoch !== input.epoch ||
		session.conversationId !== source.conversationId ||
		sessionExpired(session, deps.clock())
	)
		return false;
	const prior = byRequest(db, input.eventId);
	if (prior) {
		const recorded = observation(db, prior.id);
		if (
			recorded?.source_run_id !== input.sourceRunId ||
			recorded.event_json !== JSON.stringify(input.event)
		)
			throw new Error("request_conflict");
		return true;
	}
	if (session.activeRunId) return false;
	const set = deps.specialist?.setInTransaction(
		db,
		session.toolchainRevisionId,
	);
	if (!set) return false;
	const now = deps.clock();
	const run = {
		...original,
		id: deps.id(),
		requestId: input.eventId,
		utteranceId: null,
		status: "queued" as const,
		revision: 0,
		answerMessageId: null,
		error: null,
		jobId: null,
		sourceKind: "notice" as const,
		pinnedToolchainId: null,
		scheduleId: null,
		occurrenceId: null,
		createdAt: now,
		updatedAt: now,
		deadlineAt: new Date(
			Date.parse(now) + (set.timeLimits?.runMs ?? 120000),
		).toISOString(),
	};
	insert(db, run);
	setRunSession(db, run.id, session.id);
	db.query("INSERT INTO dialogue_specialist_observations VALUES(?,?,?,?)").run(
		run.id,
		input.eventId,
		input.sourceRunId,
		JSON.stringify(input.event),
	);
	deps.specialist!.beginTurnInTransaction(
		db,
		session.adapterRef,
		session.workRef,
		run.id,
	);
	patchSession(db, session.id, { activeRunId: run.id }, now);
	deps.larm.captureInTransaction?.(
		db,
		run.id,
		"llm",
		Date.parse(run.deadlineAt),
	);
	enqueueTurn(
		deps,
		db,
		run,
		set,
		session.id,
		session.epoch,
		source.request,
		false,
	);
	return true;
}

/** Only a persisted host event of this session may be exposed as an observation. */
export function specialistObservation(
	deps: DialogueDeps,
	db: Database,
	runId: string,
	session: SessionRecord,
) {
	const found = observation(db, runId);
	if (!found) {
		if (byId(db, runId)?.sourceKind === "notice")
			throw new Error("specialist_event_source_invalid");
		return null;
	}
	const original = byId(db, found.source_run_id),
		source = specialistExecutionSource(
			deps,
			db,
			found.source_run_id,
			session.id,
			session.epoch,
		);
	if (
		!source ||
		original?.specialistSessionId !== session.id ||
		source.conversationId !== session.conversationId
	)
		throw new Error("specialist_event_source_invalid");
	return JSON.parse(found.event_json) as unknown;
}

/** Reuse the adopted explanation; the execution's structured summary remains model input only. */
export function specialistResultText(
	deps: DialogueDeps,
	db: Database,
	sessionId: string,
	childId: string,
) {
	const session = sessionById(db, sessionId);
	const id = session && childReportRun(db, sessionId, childId);
	if (!session || !id) return null;
	if (!specialistObservation(deps, db, id, session)) return null;
	const answerId = byId(db, id)?.answerMessageId;
	return answerId
		? (deps.conversation.messageInTransaction(db, answerId)?.message.text ??
				null)
		: null;
}
