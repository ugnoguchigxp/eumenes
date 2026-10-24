import type { Database } from "bun:sqlite";
import type { ToolchainCard } from "../../capabilities";
import type { Run, SpecialistSet, Viewing } from "../contracts";
import {
	liveSession,
	markReported,
	runViewing,
	unreportedEnded,
} from "../repository";
import type { ContextBlock } from "../../inference";
import type { DialogueDeps } from "./context";
import { specialistBlock } from "./context-blocks";

/**
 * The saved items a session toolchain may start from (host-issued choices: the adapter's own list), or null for
 * a toolchain that is not a session. One that cannot be read now has no choices.
 */
export function sessionTargetsInTransaction(
	deps: DialogueDeps,
	db: Database,
	card: ToolchainCard,
	runId: string,
): Array<{ ref: string; label: string }> | null {
	const port = deps.specialist;
	const toolchains = deps.toolchains;
	if (
		!port ||
		!toolchains?.sessionSetInTransaction ||
		card.execution !== "session"
	)
		return null;
	try {
		const set = toolchains.sessionSetInTransaction(db, card.revisionId);
		return port.targetChoicesInTransaction(
			db,
			set,
			viewingTargetOf(db, runId, set),
		);
	} catch {
		return [];
	}
}

/**
 * The saved item the run's screen showed, for this toolchain only (its artifact): the adapter confirms it is
 * a real item, so one older than the most recent choices is still offered and accepted.
 */
export function viewingTargetOf(
	db: Database,
	runId: string,
	set: SpecialistSet,
): string | null {
	const viewing = runViewing(db, runId) as Viewing | null;
	return viewing && viewing.artifactRevisionId === set.artifactRevisionId
		? viewing.targetRef
		: null;
}

/**
 * What the main agent should know about specialist work, as short host facts (never the work's content):
 * a suspended unsaved work (title, label, unsaved, expiry, a switch waiting for the user), and, once, the
 * reason and label of the session that ended last.
 */
export function specialistWorkBlock(
	deps: DialogueDeps,
	tx: Database,
	run: Run,
): ContextBlock | null {
	const port = deps.specialist;
	if (!port) return null;
	const record: Record<string, unknown> = {};
	const live = liveSession(tx, run.conversationId);
	if (live?.state === "suspended") {
		const work = port.workStateInTransaction(tx, live.adapterRef, live.workRef);
		record.suspended = {
			specialist: live.title,
			toolchainId: live.toolchainId,
			label: work?.label ?? live.label,
			unsaved: work?.dirty ?? false,
			savedRef: work?.savedRef ?? null,
			expiresAt: live.expiresAt,
			...(live.pendingSwitch ? { pendingSwitch: live.pendingSwitch } : {}),
		};
	}
	const ended = unreportedEnded(tx, run.conversationId);
	if (ended) {
		record.ended = {
			specialist: ended.title,
			reason: ended.endReason,
			label: ended.label,
		};
		markReported(tx, run.conversationId);
	}
	if (!Object.keys(record).length) return null;
	return specialistBlock("specialist.work", record);
}

/**
 * The saved item on screen, only when the host issued it: the ref must be among the choices of a session
 * toolchain of that artifact. Anything else is dropped without trace (it is never an access grant).
 */
export function viewedSpecialistTarget(
	deps: DialogueDeps,
	tx: Database,
	run: Run,
) {
	const port = deps.specialist;
	const toolchains = deps.toolchains;
	if (!port || !toolchains?.sessionSetInTransaction) return null;
	const viewing = runViewing(tx, run.id) as Viewing | null;
	if (!viewing) return null;
	for (const entry of toolchains.catalogInTransaction(tx)) {
		if (
			entry.runtime.execution !== "session" ||
			entry.runtime.binding?.artifactRevisionId !== viewing.artifactRevisionId
		)
			continue;
		try {
			const set = toolchains.sessionSetInTransaction(tx, entry.revisionId);
			const found = port
				.targetChoicesInTransaction(tx, set, viewing.targetRef)
				.find((choice) => choice.ref === viewing.targetRef);
			if (found)
				return {
					specialist: set.title,
					toolchainId: set.toolchainId,
					ref: found.ref,
					label: found.label,
				};
		} catch {
			// An unavailable toolchain issues nothing.
		}
	}
	return null;
}

/** The validated saved item as context for the main agent. */
export function viewingBlock(
	deps: DialogueDeps,
	tx: Database,
	run: Run,
): ContextBlock | null {
	const viewing = viewedSpecialistTarget(deps, tx, run);
	return viewing ? specialistBlock("specialist.viewing", viewing) : null;
}
