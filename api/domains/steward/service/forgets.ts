import { getLogger } from "../../../infrastructure/logger";
import type { StewardDeps } from "./types";

const log = getLogger("steward");

const waiting = new WeakMap<StewardDeps, Set<string>>();

/**
 * World forgets are durable intakes written inside a steward transaction; World advances them (the slow part)
 * only after that transaction committed. The ids wait here and are handed to `world.resumeForget` on the next commit.
 * An id whose transaction rolled back names no intake: resuming it finds nothing.
 */
export function resumeAfterCommit(deps: StewardDeps, forgetId: string) {
	const world = deps.world;
	if (!world) return;
	let ids = waiting.get(deps);
	if (!ids) {
		const set = new Set<string>();
		ids = set;
		waiting.set(deps, set);
		deps.store.onCommit(() => {
			if (set.size === 0) return;
			const due = [...set];
			set.clear();
			for (const id of due)
				void Promise.resolve()
					.then(() => world.resumeForget(id))
					.catch((error: unknown) =>
						log.warn(
							"steward.world_forget_resume_failed",
							{ reason: "resume_failed" },
							error,
						),
					);
		});
	}
	ids.add(forgetId);
}
