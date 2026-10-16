import type { Database } from "bun:sqlite";
import type { ToolchainCard } from "../../capabilities";
import { systemContext } from "../../../infrastructure/system-context";
import type { Run, SpecialistSet, Viewing } from "../contracts";
import {
	liveSession,
	markReported,
	runViewing,
	unreportedEnded,
} from "../repository";
import type { ChatMessage, DialogueDeps } from "./context";
import type { SessionOffers } from "./conversation-tools";

const WORK_FRAME = systemContext(
	"dialogue.contexts.generation-prepare.specialist-work",
	{},
);
const VIEWING_FRAME = systemContext(
	"dialogue.contexts.generation-prepare.specialist-viewing",
	{},
);
const LABEL_CHARS = 60;

/**
 * The session toolchains among these cards with the saved items each may start from. Choices are
 * host-issued (the adapter's own list); a toolchain that cannot be read now is offered without targets.
 */
export function sessionOffers(
	deps: DialogueDeps,
	cards: readonly ToolchainCard[],
	runId: string,
): SessionOffers {
	const port = deps.specialist;
	const toolchains = deps.toolchains;
	const offers = new Map<string, Array<{ ref: string; label: string }>>();
	if (!port || !toolchains?.sessionSetInTransaction || !cards.length)
		return offers;
	deps.store.read((db) => {
		const sessions = new Set(
			toolchains
				.catalogInTransaction(db)
				.filter((entry) => entry.runtime.execution === "session")
				.map((entry) => entry.revisionId),
		);
		for (const card of cards) {
			if (!sessions.has(card.revisionId)) continue;
			try {
				const set = toolchains.sessionSetInTransaction!(db, card.revisionId);
				offers.set(
					card.functionName,
					port.targetChoicesInTransaction(
						db,
						set,
						viewingTargetOf(db, runId, set),
					),
				);
			} catch {
				offers.set(card.functionName, []);
			}
		}
	});
	return offers;
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

const clip = (text: string) => text.slice(0, LABEL_CHARS);

/**
 * What the main agent should know about specialist work, as short host facts (never the work's content):
 * a suspended unsaved work (title, label, unsaved, expiry, a switch waiting for the user), and, once, the
 * reason and label of the session that ended last.
 */
export function specialistWorkMessage(
	deps: DialogueDeps,
	tx: Database,
	run: Run,
): ChatMessage | null {
	const port = deps.specialist;
	if (!port) return null;
	const record: Record<string, unknown> = {};
	const live = liveSession(tx, run.conversationId);
	if (live?.state === "suspended") {
		const work = port.workStateInTransaction(tx, live.adapterRef, live.workRef);
		record.suspended = {
			specialist: live.title,
			toolchainId: live.toolchainId,
			label: clip(work?.label ?? live.label),
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
			label: clip(ended.label),
		};
		markReported(tx, run.conversationId);
	}
	if (!Object.keys(record).length) return null;
	return {
		role: "system",
		content: `${WORK_FRAME}\nspecialistWork=${JSON.stringify(record)}`,
	};
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
					label: clip(found.label),
				};
		} catch {
			// An unavailable toolchain issues nothing.
		}
	}
	return null;
}

/** The validated saved item as context for the main agent. */
export function viewingMessage(
	deps: DialogueDeps,
	tx: Database,
	run: Run,
): ChatMessage | null {
	const viewing = viewedSpecialistTarget(deps, tx, run);
	return viewing
		? {
				role: "system",
				content: `${VIEWING_FRAME}\nviewing=${JSON.stringify(viewing)}`,
			}
		: null;
}
