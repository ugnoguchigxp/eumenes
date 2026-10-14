import type { Database } from "bun:sqlite";
import { CONTRACT_VERSIONS } from "eumenes-memory";
import type { AccessContext } from "eumenes-memory";
import { applyForget, planForget, readStateFact } from "eumenes-memory/sqlite";
import { PROFILE_SCOPE } from "../contracts";
import { deleteTendenciesByStateEvidence } from "../repository";
import type { ContextWindowStore } from "./context-window";
import { appendJournal } from "./journal";

const VERSION = 1 as const;
export const STATE_ID = /^state:[0-9a-f]{64}$/;

/** What forgetting one item needs from the memory service around it. */
export type ForgetDeps = {
	journalPath: string;
	access: (db: Database, purpose: string) => AccessContext;
	atMs: () => number;
	windows: ContextWindowStore;
	/** Memory is usable (its journal is consistent). */
	ready: () => boolean;
	/** Removes the usage receipts that name any of the items. */
	purgeUsageFor: (db: Database, itemIds: Iterable<string>) => void;
};

function refuse(code: string): never {
	throw new Error(code);
}

/**
 * Plan -> journal (fsync) -> apply for one item and every earlier version of its fact, inside the
 * caller's writer transaction. `onJournaled` is told before the first entry is written: from then on
 * a failure may leave the journal ahead of the database.
 */
export function forgetItem(
	deps: ForgetDeps,
	db: Database,
	itemId: string,
	onJournaled: () => void,
): { forgetId: string; completed: boolean } {
	const { access, atMs, windows } = deps;
	// Earlier versions of the same fact (superseded / stopped) carry the old value too.
	const fact = readStateFact(db, {
		contractVersion: VERSION,
		access: access(db, "memory.forget"),
		scopeKey: PROFILE_SCOPE,
		itemId,
	});
	if (fact.status !== "ok") return refuse("invalid_memory_item");
	const ids = fact.itemIds;
	let forgetId = "";
	let completed = true;
	for (const id of ids) {
		const planned = planForget(db, {
			contractVersion: CONTRACT_VERSIONS.lifecycle,
			access: access(db, "memory.forget"),
			target: { type: "state_item", itemId: id, scopeKey: PROFILE_SCOPE },
			clock: { atMs: atMs() },
		});
		if (planned.status !== "planned") return refuse("invalid_memory_item");
		onJournaled();
		appendJournal(deps.journalPath, planned.plan.entry);
		const applied = applyForget(db, {
			contractVersion: CONTRACT_VERSIONS.lifecycle,
			entry: planned.plan.entry,
			clock: { atMs: atMs() },
		});
		if (id === itemId) forgetId = planned.plan.entry.forgetId;
		completed = completed && applied.completed;
		deps.purgeUsageFor(db, [id]);
		windows.recordImmediateInTransaction(db, "state_forget", null);
		// The rendered windows still hold the forgotten text.
		windows.purgeInTransaction(db);
	}
	// Summaries the agent derived from these items go with them (same transaction as the forget).
	deleteTendenciesByStateEvidence(db, ids);
	return { forgetId, completed };
}

/** `forgetItem` for a request: the id must be a State id and memory must be usable. */
export function forgetChecked(
	deps: ForgetDeps,
	db: Database,
	itemId: string,
	onJournaled: () => void,
) {
	if (!STATE_ID.test(itemId)) return refuse("invalid_memory_item");
	if (!deps.ready()) return refuse("memory_unavailable");
	return forgetItem(deps, db, itemId, onJournaled);
}
