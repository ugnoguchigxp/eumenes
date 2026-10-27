import type { Database } from "bun:sqlite";
import { getLogger } from "../../../infrastructure/logger";
import {
	MEDIA_GENERATION_TIMEOUT_MS,
	type ToolchainRuntimeMeta,
} from "../../capabilities";
import type { Run } from "../contracts";
import { extendRunDeadline } from "../repository";
import type { DialogueDeps } from "./context";

/** Reuse run deadline extension for on-demand generation while preserving caller limits. */
export function extendMediaDeadline(
	deps: Pick<DialogueDeps, "clock" | "larm">,
	db: Database,
	run: Run,
	execution: ToolchainRuntimeMeta["execution"],
	toolchainId: string,
): Run {
	if (
		(execution !== "image" && execution !== "music-create") ||
		run.deadlineFixed !== false
	)
		return run;
	const until = Date.parse(deps.clock()) + MEDIA_GENERATION_TIMEOUT_MS;
	if (until <= Date.parse(run.deadlineAt!)) return run;
	const deadlineAt = new Date(until).toISOString();
	extendRunDeadline(db, run.id, deadlineAt);
	deps.larm.extendDeadlineInTransaction?.(db, run.id, until);
	getLogger("dialogue").info("dialogue.deadline_extended", {
		runId: run.id,
		toolchainId,
		limitMs: MEDIA_GENERATION_TIMEOUT_MS,
	});
	return { ...run, deadlineAt };
}
