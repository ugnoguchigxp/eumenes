import type { Database } from "bun:sqlite";
import type { ToolchainCard } from "../../capabilities";
import type { Run, SpecialistSet, Viewing } from "../contracts";
import { runViewing } from "../repository";
import type { DialogueDeps } from "./context";

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
