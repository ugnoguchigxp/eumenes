import type { Database } from "bun:sqlite";
import type { MemoryService, PreparedWindow, SettleResult } from "../../memory";
import type { Run } from "../contracts";

/** True when a message the prompt showed was blocked after prepare (forgotten while the answer was generated). */
export function shownMessageForgotten(
	memory: MemoryService,
	tx: Database,
	prepared: { window: PreparedWindow; blockedAtPrepare?: string[] },
): boolean {
	const known = new Set(prepared.blockedAtPrepare);
	for (const id of memory.blockedMessageIdsInTransaction(
		tx,
		prepared.window.shownMessageIds,
	))
		if (!known.has(id)) return true;
	return false;
}

/**
 * Adoption check of the memory window a run was prepared with; the usage receipt is written only on success.
 * `recallPins`: messages the exchanges recalled for this turn stand on. A quiet window (it adds nothing to the
 * prompt) is validated only when a recalled exchange stands on it; the shown messages are always checked.
 */
export function adoptMemoryWindow(
	memory: MemoryService,
	tx: Database,
	run: Run,
	prepared: {
		window: PreparedWindow;
		quiet?: true;
		blockedAtPrepare?: string[];
	},
	recallPins: ReadonlyArray<{ messageId: string; digest: string }> = [],
): SettleResult {
	// Also for a quiet window: history forgotten meanwhile must not stand behind an adopted answer.
	if (shownMessageForgotten(memory, tx, prepared))
		return { ok: false, reason: "memory_stale" };
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
