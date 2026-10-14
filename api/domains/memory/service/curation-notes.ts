import type { Database } from "bun:sqlite";
import { continuityKinds } from "../../continuity/contracts";
import type {
	CurationItem,
	CurationRejection,
	CurationResult,
} from "../contracts";
import {
	countActiveTendencies,
	getTendency,
	insertTendency,
	isBlocked,
	retireTendency,
	updateTendency,
	type TendencyEvidence,
} from "../repository";
import {
	MAX_TEXT_CHARS,
	applied,
	rejected,
	type CurationDeps,
} from "./curation-shared";
import type { StateWriter } from "./curation-state";

const MAX_ACTIVE_TENDENCIES = 20;
const MAX_TENDENCY_CHARS = 120;

/** Short-term notes and tendencies. */
export function createNoteOps(deps: CurationDeps, writer: StateWriter) {
	const { conversation, continuity, clock } = deps;
	const { items } = writer;

	// ---- continuity notes ----

	function noteOf(db: Database, conversationId: string, noteId: string) {
		return continuity
			.snapshotInTransaction(db, conversationId)
			.items.find((note) => note.id === noteId);
	}
	/** The sources of a note: messages of this conversation that may still be used; the refusal otherwise. */
	function checkedSources(
		db: Database,
		conversationId: string,
		messageIds: readonly string[],
	): { ok: true; ids: string[] } | { ok: false; reason: CurationRejection } {
		const ids = [...new Set(messageIds)];
		for (const id of ids) {
			const found = conversation.messageInTransaction(db, id);
			if (!found || found.message.conversationId !== conversationId)
				return { ok: false, reason: "invalid_source" };
			if (isBlocked(db, id)) return { ok: false, reason: "blocked_source" };
		}
		return { ok: true, ids };
	}
	function noteAdd(
		db: Database,
		conversationId: string,
		item: Extract<CurationItem, { op: "note_add" }>,
	): CurationResult {
		if (!(continuityKinds as readonly string[]).includes(item.kind))
			return rejected("note_add", "invalid_input");
		const text = item.text.trim();
		if (text === "" || [...text].length > MAX_TEXT_CHARS)
			return rejected("note_add", "invalid_input");
		if (!Array.isArray(item.messageIds) || item.messageIds.length === 0)
			return rejected("note_add", "invalid_source");
		const sources = checkedSources(db, conversationId, item.messageIds);
		if (!sources.ok) return rejected("note_add", sources.reason);
		const note = continuity.addByAgentInTransaction(db, conversationId, {
			kind: item.kind,
			text,
			sourceMessageIds: sources.ids,
		});
		return applied("note_add", { id: note.id, revision: note.revision });
	}
	function noteUpdate(
		db: Database,
		conversationId: string,
		item: Extract<CurationItem, { op: "note_update" }>,
	): CurationResult {
		const note = noteOf(db, conversationId, item.noteId);
		if (!note) return rejected("note_update", "unknown_item");
		const text = item.text.trim();
		if (text === "" || [...text].length > MAX_TEXT_CHARS)
			return rejected("note_update", "invalid_input");
		if (note.revision !== item.revision)
			return rejected("note_update", "item_changed");
		let added: string[] = [];
		if (item.messageIds !== undefined) {
			const sources = checkedSources(db, conversationId, item.messageIds);
			if (!sources.ok) return rejected("note_update", sources.reason);
			added = sources.ids;
		}
		const updated = continuity.updateByAgentInTransaction(
			db,
			item.noteId,
			item.revision,
			{ text, addSourceMessageIds: added },
		);
		return updated
			? applied("note_update", { id: updated.id, revision: updated.revision })
			: rejected("note_update", "item_changed");
	}
	function noteClose(
		db: Database,
		conversationId: string,
		item: Extract<CurationItem, { op: "note_close" }>,
	): CurationResult {
		const note = noteOf(db, conversationId, item.noteId);
		if (!note) return rejected("note_close", "unknown_item");
		if (item.status !== "resolved" && item.status !== "retracted")
			return rejected("note_close", "invalid_input");
		return continuity.closeByAgentInTransaction(
			db,
			item.noteId,
			item.revision,
			item.status,
		)
			? applied("note_close", { id: item.noteId, revision: item.revision + 1 })
			: rejected("note_close", "item_changed");
	}

	// ---- tendencies ----

	/** The evidence of a tendency: at least two distinct items that still count. */
	function tendencyEvidence(
		db: Database,
		conversationId: string,
		evidence: ReadonlyArray<TendencyEvidence>,
	): TendencyEvidence[] | null {
		if (evidence.length < 2) return null;
		const activeState = new Set(
			items(db, false)
				.filter((state) => state.status === "active")
				.map((state) => state.itemId),
		);
		const liveNotes = new Set(
			continuity
				.snapshotInTransaction(db, conversationId)
				.items.map((note) => note.id),
		);
		const out: TendencyEvidence[] = [];
		for (const entry of evidence) {
			if (entry.namespace === "state" && activeState.has(entry.id))
				out.push({ namespace: "state", id: entry.id });
			else if (entry.namespace === "continuity" && liveNotes.has(entry.id))
				out.push({ namespace: "continuity", id: entry.id });
			else return null;
		}
		return new Set(out.map((entry) => `${entry.namespace}:${entry.id}`))
			.size === out.length
			? out
			: null;
	}
	function tendencyAdd(
		db: Database,
		conversationId: string,
		item: Extract<CurationItem, { op: "tendency_add" }>,
	): CurationResult {
		const text = item.text.trim();
		if (text === "" || [...text].length > MAX_TENDENCY_CHARS)
			return rejected("tendency_add", "invalid_input");
		const evidence = tendencyEvidence(db, conversationId, item.evidence);
		if (!evidence) return rejected("tendency_add", "invalid_input");
		if (countActiveTendencies(db) >= MAX_ACTIVE_TENDENCIES)
			return rejected("tendency_add", "limit_reached");
		const now = clock();
		const id = deps.id();
		insertTendency(db, {
			id,
			text,
			evidence,
			status: "active",
			revision: 1,
			createdAt: now,
			updatedAt: now,
		});
		return applied("tendency_add", { id, revision: 1 });
	}
	function tendencyUpdate(
		db: Database,
		conversationId: string,
		item: Extract<CurationItem, { op: "tendency_update" }>,
	): CurationResult {
		const text = item.text.trim();
		if (text === "" || [...text].length > MAX_TENDENCY_CHARS)
			return rejected("tendency_update", "invalid_input");
		const evidence = tendencyEvidence(db, conversationId, item.evidence);
		if (!evidence) return rejected("tendency_update", "invalid_input");
		const row = getTendency(db, item.tendencyId);
		if (!row) return rejected("tendency_update", "unknown_item");
		if (row.status !== "active" || row.revision !== item.revision)
			return rejected("tendency_update", "item_changed");
		return updateTendency(
			db,
			item.tendencyId,
			item.revision,
			{ text, evidence },
			clock(),
		)
			? applied("tendency_update", {
					id: item.tendencyId,
					revision: item.revision + 1,
				})
			: rejected("tendency_update", "item_changed");
	}
	function tendencyRetire(
		db: Database,
		item: Extract<CurationItem, { op: "tendency_retire" }>,
	): CurationResult {
		const row = getTendency(db, item.tendencyId);
		if (!row) return rejected("tendency_retire", "unknown_item");
		return retireTendency(db, item.tendencyId, item.revision, clock())
			? applied("tendency_retire", {
					id: item.tendencyId,
					revision: item.revision + 1,
				})
			: rejected("tendency_retire", "item_changed");
	}

	return {
		noteAdd,
		noteUpdate,
		noteClose,
		tendencyAdd,
		tendencyUpdate,
		tendencyRetire,
	};
}
