import type { Database } from "bun:sqlite";
import type { MemoryService, PreparedWindow, SettleResult } from "../../memory";
import type { Run } from "../contracts";

/**
 * What a run keeps of the memory it read (fixed at prepare, checked at adoption): the window's versions, the messages
 * already blocked, and the key of the short references the prompt shows.
 */
export type PreparedMemory = {
	window: PreparedWindow;
	/** A quiet window adds nothing to the prompt: it is not validated. */
	quiet?: true;
	/** The shown messages already blocked at prepare time; one blocked later expires the generation. */
	blockedAtPrepare?: string[];
	/** The window the prompt's short references (`m1`...) were handed out in. */
	refsKey: string;
};

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
	prepared: PreparedMemory,
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
	prepared: PreparedMemory,
): SettleResult {
	if (shownMessageForgotten(memory, tx, prepared))
		return { ok: false, reason: "memory_stale" };
	if (prepared.quiet) return { ok: true };
	// The memory's own check leaves out the changes this run made through its `memory` calls (they carry its id).
	return memory.validateWindowInTransaction(tx, runId, prepared.window);
}
