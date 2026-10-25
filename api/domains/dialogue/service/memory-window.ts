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
 * A quiet window (it adds nothing to the prompt) is not validated; the shown messages are always checked.
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
): SettleResult {
	const verdict = validateMemoryWindow(memory, tx, run.id, prepared);
	if (verdict.ok && !prepared.quiet)
		memory.recordUsageInTransaction(
			tx,
			run.id,
			run.conversationId,
			prepared.window,
		);
	return verdict;
}

/** The same checks before releasing a streaming clause, without recording final usage. */
export function validateMemoryWindow(
	memory: MemoryService,
	tx: Database,
	runId: string,
	prepared: {
		window: PreparedWindow;
		quiet?: true;
		blockedAtPrepare?: string[];
	},
): SettleResult {
	if (shownMessageForgotten(memory, tx, prepared))
		return { ok: false, reason: "memory_stale" };
	if (prepared.quiet) return { ok: true };
	return memory.validateWindowInTransaction(tx, runId, prepared.window);
}
