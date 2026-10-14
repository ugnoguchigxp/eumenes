import type { Database } from "bun:sqlite";
import { MemoryContractError } from "eumenes-memory";
import { getLogger } from "../../../infrastructure/logger";
import type {
	CurationItem,
	CurationRejection,
	CurationResult,
} from "../contracts";
import { createEvidence } from "./curation-evidence";
import { createMerge } from "./curation-merge";
import { createNoteOps } from "./curation-notes";
import { rejected, type CurationDeps } from "./curation-shared";
import { createStateWriter } from "./curation-state";
import { createStateOps } from "./curation-state-ops";

const log = getLogger("memory");

/** A thrown library or host error as an element refusal; null for anything unexpected. */
function reasonOf(error: unknown): CurationRejection | null {
	if (error instanceof MemoryContractError) return "invalid_input";
	switch (error instanceof Error ? error.message : "") {
		case "invalid_continuity_limit":
		case "invalid_memory_limit":
			return "limit_reached";
		default:
			return null;
	}
}

export function createCuration(deps: CurationDeps) {
	const evidence = createEvidence(deps);
	const writer = createStateWriter(deps);
	const state = createStateOps(deps, evidence, writer);
	const { merge } = createMerge(deps, evidence, writer);
	const notes = createNoteOps(deps, writer);

	function dispatch(
		db: Database,
		conversationId: string,
		item: CurationItem,
	): CurationResult {
		switch (item.op) {
			case "remember":
				return state.remember(db, conversationId, item);
			case "update":
				return state.update(db, conversationId, item);
			case "stop":
				return state.stop(db, item);
			case "merge":
				return merge(db, item);
			case "note_add":
				return notes.noteAdd(db, conversationId, item);
			case "note_update":
				return notes.noteUpdate(db, conversationId, item);
			case "note_close":
				return notes.noteClose(db, conversationId, item);
			case "tendency_add":
				return notes.tendencyAdd(db, conversationId, item);
			case "tendency_update":
				return notes.tendencyUpdate(db, conversationId, item);
			case "tendency_retire":
				return notes.tendencyRetire(db, item);
			default:
				return rejected(
					(item as { op: CurationItem["op"] }).op,
					"invalid_input",
				);
		}
	}

	return {
		/**
		 * The steward's save, element by element: a refusal (or an error) leaves no trace of that element, and the
		 * elements before it stay. An unexpected error is a refusal too (`conflict`), logged without text.
		 */
		applyCurationInTransaction(
			db: Database,
			input: { conversationId: string; items: readonly CurationItem[] },
		): CurationResult[] {
			if (!deps.ready()) throw new Error("memory_unavailable");
			return input.items.map((item) => {
				db.exec("SAVEPOINT memory_curation_item");
				let result: CurationResult;
				try {
					result = dispatch(db, input.conversationId, item);
				} catch (error) {
					db.exec("ROLLBACK TO memory_curation_item");
					db.exec("RELEASE memory_curation_item");
					const reason = reasonOf(error);
					if (reason === null) {
						log.warn(
							"memory.curation_item_failed",
							{ reason: "unexpected_error" },
							error,
						);
						return rejected(item.op, "conflict");
					}
					return rejected(item.op, reason);
				}
				if (result.status === "rejected")
					db.exec("ROLLBACK TO memory_curation_item");
				db.exec("RELEASE memory_curation_item");
				return result;
			});
		},
	};
}
