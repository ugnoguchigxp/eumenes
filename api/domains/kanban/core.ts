import type { Database } from "bun:sqlite";
import { sha256Hex } from "../../infrastructure/digest";
import type {
	KanbanCardReceipt,
	KanbanColumn,
	KanbanDispatch,
	KanbanReceipt,
} from "./contracts";
import {
	columnIds,
	getCard,
	getReceipt,
	placeColumn,
	saveReceipt,
	type CardRow,
} from "./repository";

/** What an operation returns: its receipt and, when a run became ready, what to hand over. */
export type KanbanOutcome<R extends KanbanReceipt = KanbanCardReceipt> = {
	receipt: R;
	replay: boolean;
	/** Never set on a replay: the first execution already handed it over. */
	dispatch?: KanbanDispatch;
};
export type Applied<R extends KanbanReceipt = KanbanCardReceipt> = {
	receipt: R;
	dispatch?: KanbanDispatch;
};

/** Pieces shared by the card and run operations of one service. */
export function createCore(options: { now: () => number; newId: () => string }) {
	const { now, newId } = options;

	/** Replays a saved receipt for the same request, or applies the operation once. */
	function operate<R extends KanbanReceipt = KanbanCardReceipt>(
		tx: Database,
		requestId: string,
		operation: string,
		input: unknown,
		apply: () => Applied<R>,
	): KanbanOutcome<R> {
		const digest = sha256Hex(JSON.stringify([operation, input]));
		const saved = getReceipt(tx, requestId);
		if (saved) {
			if (saved.operation !== operation || saved.digest !== digest)
				throw new Error("request_conflict");
			return { receipt: saved.receipt as R, replay: true };
		}
		const applied = apply();
		saveReceipt(tx, requestId, operation, digest, applied.receipt, now());
		return { ...applied, replay: false };
	}

	/** The card, after the revision check. */
	function target(
		tx: Database,
		cardId: string,
		expectedRevision: number,
	): CardRow {
		const card = getCard(tx, cardId);
		if (!card) throw new Error("kanban_card_not_found");
		if (card.revision !== expectedRevision)
			throw new Error("revision_conflict");
		return card;
	}

	function receiptOf(
		action: KanbanCardReceipt["action"],
		card: CardRow,
		runId?: string,
	): KanbanCardReceipt {
		return {
			action,
			cardId: card.id,
			revision: card.revision,
			title: card.title,
			column: card.column,
			...(runId ? { runId } : {}),
		};
	}

	/**
	 * Stores the card as the last one of `column` (the card row already carries the column);
	 * the column it left is renumbered.
	 */
	function appendToColumn(tx: Database, card: CardRow, from: KanbanColumn) {
		const ids = columnIds(tx, card.column).filter((id) => id !== card.id);
		placeColumn(tx, [...ids, card.id]);
		if (from !== card.column) placeColumn(tx, columnIds(tx, from));
	}

	return { now, newId, operate, target, receiptOf, appendToColumn };
}
export type Core = ReturnType<typeof createCore>;
