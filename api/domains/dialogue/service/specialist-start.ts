import type { Database } from "bun:sqlite";
import { systemContext } from "../../../infrastructure/system-context";
import { getLogger } from "../../../infrastructure/logger";
import type { Run, SpecialistSet } from "../contracts";
import {
	insertSession,
	linkAnswer,
	liveSession,
	patchSession,
	setRunSession,
	type SessionRecord,
} from "../repository";
import { GENERATE_KIND, SPECIALIST_KIND, type DialogueDeps } from "./context";
import type { ConversationOperation } from "./conversation-tools";
import { viewingTargetOf } from "./specialist-context";
import {
	blockSpecialistMessages,
	deferFlush,
	endOrMarkClosing,
	expiryAfter,
	extendRunForToolchain,
	safeCode,
	sessionExpired,
} from "./specialist-core";

const log = getLogger("dialogue");
const SWITCH_NOTE = systemContext(
	"dialogue.contexts.generation-prepare.specialist-switch",
	{},
);

export type StartResult = { ok: true } | { ok: false; code: string };
const refuse = (code: string): StartResult => ({ ok: false, code });

/** Queue the specialist's turn; a toolchain with its own run time gets it from here. */
function enqueueTurn(
	deps: DialogueDeps,
	tx: Database,
	handed: Run,
	set: SpecialistSet,
	sessionId: string,
	epoch: number,
	request: string,
) {
	const run = extendRunForToolchain(deps, tx, handed, set);
	const { job } = deps.queue.enqueueInTransaction(tx, {
		scope: "dialogue",
		kind: SPECIALIST_KIND,
		dedupeKey: `specialist-turn:${run.id}:${sessionId}:${epoch}`,
		payload: { runId: run.id, epoch, request: request.slice(0, 8000) },
		subjectRef: run.id,
		lane: "interactive",
		resourceKey: "inference.llm",
		maxAttempts: 1,
		concurrencyKey: `conversation:${run.conversationId}`,
		deadlineAtMs: Date.parse(run.deadlineAt!),
	});
	linkAnswer(tx, run.id, job.id);
}

/** The main agent asks the user whether to drop the unsaved work: the switch has not happened. */
function askToResolve(
	deps: DialogueDeps,
	tx: Database,
	run: Run,
	live: SessionRecord,
	label: string,
	incoming: { title: string; targetRef: string | null },
) {
	const note = `${SWITCH_NOTE} 現在の作業=${JSON.stringify({
		specialist: live.title,
		label,
	})} 切替先=${JSON.stringify({
		specialist: incoming.title,
		targetRef: incoming.targetRef,
	})}`;
	const { job } = deps.queue.enqueueInTransaction(tx, {
		scope: "dialogue",
		kind: GENERATE_KIND,
		dedupeKey: `toolchain-answer:${run.id}`,
		payload: { runId: run.id, commandNote: note },
		subjectRef: run.id,
		lane: "interactive",
		resourceKey: "inference.llm",
		maxAttempts: 1,
		concurrencyKey: `conversation:${run.conversationId}`,
		deadlineAtMs: Date.parse(run.deadlineAt!),
	});
	linkAnswer(tx, run.id, job.id);
}

/** Take the work for this run's turn and address the session to it. */
function addressTurn(
	deps: DialogueDeps,
	tx: Database,
	run: Run,
	session: SessionRecord,
) {
	deps.specialist!.beginTurnInTransaction(
		tx,
		session.adapterRef,
		session.workRef,
		run.id,
	);
	setRunSession(tx, run.id, session.id);
	blockSpecialistMessages(deps, tx, run.conversationId, [run.inputMessageId]);
	patchSession(tx, session.id, { activeRunId: run.id }, deps.clock());
}

/**
 * The conversation chose a session toolchain: hand the run to its specialist (a new session, or the
 * suspended work of the same target resumed), or, when a different unsaved work stands in the way, have the
 * main agent ask the user first. Either way the run continues as a queued job; the caller queues the run.
 * Nothing is left half done when it refuses.
 */
export function startSpecialistSession(
	deps: DialogueDeps,
	tx: Database,
	run: Run,
	chosen: ConversationOperation,
): StartResult {
	const port = deps.specialist;
	const sessionSet = deps.toolchains?.sessionSetInTransaction;
	if (!port || !sessionSet) return refuse("specialist_unavailable");
	let set: SpecialistSet;
	try {
		set = sessionSet.call(deps.toolchains, tx, chosen.revisionId);
	} catch {
		return refuse("toolchain_unavailable");
	}
	const target = chosen.target ?? null;
	if (
		target !== null &&
		!port
			.targetChoicesInTransaction(tx, set, viewingTargetOf(tx, run.id, set))
			.some((c) => c.ref === target)
	)
		return refuse("target_not_found");
	const savepoint = "dialogue_specialist_start";
	tx.exec(`SAVEPOINT ${savepoint}`);
	try {
		const result = start(deps, tx, run, chosen, set, target);
		if (!result.ok) {
			tx.exec(`ROLLBACK TO ${savepoint}`);
		}
		tx.exec(`RELEASE ${savepoint}`);
		return result;
	} catch (error) {
		tx.exec(`ROLLBACK TO ${savepoint}`);
		tx.exec(`RELEASE ${savepoint}`);
		const code = safeCode(error, "specialist_start_failed");
		log.warn("dialogue.specialist_start_failed", { reason: code });
		return refuse(code);
	}
}

function start(
	deps: DialogueDeps,
	tx: Database,
	run: Run,
	chosen: ConversationOperation,
	set: SpecialistSet,
	target: string | null,
): StartResult {
	const port = deps.specialist!;
	const now = deps.clock();
	let live = liveSession(tx, run.conversationId);
	if (live && sessionExpired(live, now)) {
		const ended = endOrMarkClosing(deps, tx, live, "expired");
		deferFlush(deps, ended);
		if (ended.state === "closing") return refuse("specialist_closing");
		live = null;
	}
	if (live?.state === "closing") return refuse("specialist_closing");
	if (live) {
		const work = port.workStateInTransaction(tx, live.adapterRef, live.workRef);
		const same =
			live.toolchainId === set.toolchainId &&
			(work?.savedRef ?? null) === target;
		if (same) {
			// The same work goes on: a suspended one is resumed (a new addressee epoch), an active one continues.
			const epoch = live.state === "suspended" ? live.epoch + 1 : live.epoch;
			patchSession(
				tx,
				live.id,
				{
					state: "active",
					epoch,
					expiresAt: expiryAfter(now),
					pendingSwitch: null,
					bump: live.state === "suspended" || live.pendingSwitch !== null,
				},
				now,
			);
			addressTurn(deps, tx, run, live);
			enqueueTurn(deps, tx, run, set, live.id, epoch, chosen.request);
			return { ok: true };
		}
		const dirty = work?.dirty ?? false;
		if (dirty && work) {
			const pending = live.pendingSwitch;
			const confirmed =
				chosen.resolveUnsaved === "discard" &&
				pending?.toolchainId === set.toolchainId &&
				pending.targetRef === target &&
				pending.workRevision === work.revision;
			if (!confirmed) {
				// The user decides: the work stays as it is, and a changed work needs a new decision.
				patchSession(
					tx,
					live.id,
					{
						pendingSwitch: {
							toolchainId: set.toolchainId,
							targetRef: target,
							workRevision: work.revision,
						},
						label: work.label,
						bump: true,
					},
					now,
				);
				askToResolve(deps, tx, run, live, work.label, {
					title: set.title,
					targetRef: target,
				});
				return { ok: true };
			}
		}
		const switched = endOrMarkClosing(
			deps,
			tx,
			live,
			dirty ? "discarded" : "closed",
		);
		deferFlush(deps, switched);
		if (switched.state === "closing") return refuse("specialist_closing");
	}
	const session = openSessionInTransaction(
		deps,
		tx,
		set,
		run.conversationId,
		target,
	);
	addressTurn(deps, tx, run, session);
	enqueueTurn(deps, tx, run, set, session.id, session.epoch, chosen.request);
	return { ok: true };
}

/** A new active session of this set on the conversation, its work opened from the target (or empty). */
export function openSessionInTransaction(
	deps: DialogueDeps,
	tx: Database,
	set: SpecialistSet,
	conversationId: string,
	target: string | null,
): SessionRecord {
	const now = deps.clock();
	const sessionId = deps.id();
	const work = deps.specialist!.openWorkInTransaction(tx, set, {
		sessionId,
		targetRef: target,
	});
	const session: SessionRecord = {
		id: sessionId,
		conversationId,
		toolchainId: set.toolchainId,
		toolchainRevisionId: set.toolchainRevisionId,
		title: set.title,
		bindingRevisionId: set.bindingRevisionId,
		packageRevisionId: set.packageRevisionId,
		artifactRevisionId: set.artifactRevisionId,
		adapterRef: set.adapterRef,
		workRef: work.workRef,
		state: "active",
		endReason: null,
		closingReason: null,
		closeFailures: 0,
		revision: 0,
		epoch: 1,
		activeRunId: null,
		pendingSwitch: null,
		label: work.label,
		reported: false,
		expiresAt: expiryAfter(now),
		createdAt: now,
		updatedAt: now,
	};
	insertSession(tx, session);
	return session;
}
