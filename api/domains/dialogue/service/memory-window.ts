import type { Database } from "bun:sqlite";
import type { MemoryService, PreparedWindow, SettleResult } from "../../memory";
import type { Run } from "../contracts";

/**
 * Adoption check of the memory window a run was prepared with; the usage receipt is written only on success.
 * `recallPins`: messages the exchanges recalled for this turn stand on. A quiet window (it adds nothing to the
 * prompt) is checked only when a recalled exchange stands on it.
 */
export function adoptMemoryWindow(
	memory: MemoryService,
	tx: Database,
	run: Run,
	prepared: { window: PreparedWindow; quiet?: true },
	recallPins: ReadonlyArray<{ messageId: string; digest: string }> = [],
): SettleResult {
	if (prepared.quiet && recallPins.length === 0) return { ok: true };
	const { window } = prepared;
	const verdict = memory.validateWindowInTransaction(
		tx,
		run.id,
		window,
		recallPins,
	);
	if (verdict.ok)
		memory.recordUsageInTransaction(tx, run.id, run.conversationId, window);
	return verdict;
}

/** The notices this answer carried are shown once: only an adopted answer clears them. */
export function clearShownNotices(
	memory: MemoryService,
	tx: Database,
	run: Run,
	prepared: { window: PreparedWindow },
) {
	memory.clearNoticesInTransaction(
		tx,
		run.conversationId,
		prepared.window.noticeIds,
	);
}
