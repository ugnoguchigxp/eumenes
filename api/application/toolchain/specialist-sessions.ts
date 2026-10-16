import { intervalLifecycle, type Lifecycle } from "../lifecycle";
import type { DialogueService } from "../../domains/dialogue";

/** How often the dialogue's specialist sessions are swept (expiry, closing retries, saved suspended work). */
export const SPECIALIST_SWEEP_MS = 60_000;

/**
 * The specialist sessions' lifecycle: at startup every session that was not ended ends as restarted (the
 * dialogue and the owning domains end the work in one writer transaction), then a periodic sweep ends
 * expired ones and retries `closing` ones. It runs with no browser connected.
 */
export function createSpecialistSessionsLifecycle(
	dialogue: Pick<
		DialogueService,
		"sweepSpecialistSessions" | "recoverSpecialistSessions"
	>,
): Lifecycle {
	const sweep = intervalLifecycle(
		"specialist_sessions",
		SPECIALIST_SWEEP_MS,
		() => dialogue.sweepSpecialistSessions(),
	);
	return Object.assign(sweep, {
		recover: () => dialogue.recoverSpecialistSessions(),
	});
}
