import type { Database } from "bun:sqlite";
import type { SqliteStore } from "../../infrastructure/sqlite";
import { sha256Hex } from "../../infrastructure/digest";
import {
	DEFAULT_PROJECT_ID,
	type KanbanAddInput,
	type KanbanBoardView,
	type KanbanCardActionName,
	type KanbanCardRefInput,
	type KanbanCardView,
	type KanbanEditInput,
	type KanbanMoveInput,
	type KanbanReceipt,
	type KanbanViewContext,
} from "./contracts";
import {
	allCards,
	boardRevision,
	bumpBoard,
	columnIds,
	deleteCard,
	getCard,
	getReceipt,
	insertCard,
	placeColumn,
	saveReceipt,
	updateCard,
	type CardRow,
} from "./repository";

export type KanbanOutcome = { receipt: KanbanReceipt; replay: boolean };

const iso = (ms: number) => new Date(ms).toISOString();

/**
 * The actions allowed now, decided from the column (business rule, plan §3.8). P1 knows no runs:
 * a running card can only be opened; cards outside `running` can be edited, removed and run
 * (when runs can be tracked on this host).
 */
export function cardActions(
	card: Pick<CardRow, "column">,
	view: KanbanViewContext,
): KanbanCardActionName[] {
	if (card.column === "running") return ["open"];
	const actions: KanbanCardActionName[] = ["edit", "remove"];
	if (view.runnable) actions.push("run");
	if (card.column === "finished") actions.push("open");
	return actions;
}

function cardView(card: CardRow, view: KanbanViewContext): KanbanCardView {
	return {
		id: card.id,
		revision: card.revision,
		title: card.title,
		prompt: card.prompt,
		column: card.column,
		...(card.label ? { label: card.label } : {}),
		reviewed: card.reviewed,
		commitPushReported: card.commitPushReported,
		followedByOtherRun: false,
		projectId: card.projectId,
		files: [],
		position: card.position,
		actions: cardActions(card, view),
		createdAt: iso(card.createdAt),
		updatedAt: iso(card.updatedAt),
	};
}

export function createKanban(options: {
	store: SqliteStore;
	now?: () => number;
	id?: () => string;
}) {
	const now = options.now ?? Date.now;
	const newId = options.id ?? (() => crypto.randomUUID());

	/** Replays a saved receipt for the same request, or applies the operation once. */
	function operate(
		tx: Database,
		requestId: string,
		operation: string,
		input: unknown,
		apply: () => KanbanReceipt,
	): KanbanOutcome {
		const digest = sha256Hex(JSON.stringify([operation, input]));
		const saved = getReceipt(tx, requestId);
		if (saved) {
			if (saved.operation !== operation || saved.digest !== digest)
				throw new Error("request_conflict");
			return { receipt: saved.receipt, replay: true };
		}
		const receipt = apply();
		saveReceipt(tx, requestId, operation, digest, receipt, now());
		return { receipt, replay: false };
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

	function notRunning(card: CardRow) {
		if (card.column === "running") throw new Error("kanban_card_busy");
	}

	/** Where in `ids` (the target column without the moved card) a card goes; null = the end. */
	function insertIndex(
		tx: Database,
		ids: readonly string[],
		beforeCardId: string | null | undefined,
	): number {
		if (beforeCardId === undefined || beforeCardId === null) return ids.length;
		const index = ids.indexOf(beforeCardId);
		if (index >= 0) return index;
		// Not in the target column: missing, or in another column.
		if (!getCard(tx, beforeCardId)) throw new Error("kanban_card_not_found");
		throw new Error("kanban_column_invalid");
	}

	function receiptOf(
		action: KanbanReceipt["action"],
		card: CardRow,
	): KanbanReceipt {
		return {
			action,
			cardId: card.id,
			revision: card.revision,
			title: card.title,
			column: card.column,
		};
	}

	function addInTransaction(
		tx: Database,
		input: KanbanAddInput,
		requestId: string,
	): KanbanOutcome {
		return operate(tx, requestId, "add", input, () => {
			const ids = columnIds(tx, "todo");
			const index = insertIndex(tx, ids, input.beforeCardId);
			const at = now();
			const card: CardRow = {
				id: newId(),
				revision: 1,
				title: input.title,
				prompt: input.prompt,
				column: "todo",
				label: null,
				reviewed: false,
				commitPushReported: false,
				projectId: DEFAULT_PROJECT_ID,
				position: ids.length,
				createdAt: at,
				updatedAt: at,
			};
			insertCard(tx, card);
			ids.splice(index, 0, card.id);
			placeColumn(tx, ids);
			bumpBoard(tx);
			return receiptOf("added", card);
		});
	}

	function editInTransaction(
		tx: Database,
		input: KanbanEditInput,
		requestId: string,
	): KanbanOutcome {
		return operate(tx, requestId, "edit", input, () => {
			const card = target(tx, input.cardId, input.expectedRevision);
			notRunning(card);
			const title = input.title ?? card.title;
			const prompt = input.prompt ?? card.prompt;
			// Nothing changes: the revision stays, so a no-op edit never conflicts later.
			if (title === card.title && prompt === card.prompt)
				return receiptOf("edited", card);
			const edited: CardRow = {
				...card,
				title,
				prompt,
				revision: card.revision + 1,
				updatedAt: now(),
			};
			updateCard(tx, edited);
			bumpBoard(tx);
			return receiptOf("edited", edited);
		});
	}

	function moveInTransaction(
		tx: Database,
		input: KanbanMoveInput,
		requestId: string,
	): KanbanOutcome {
		return operate(tx, requestId, "move", input, () => {
			const card = target(tx, input.cardId, input.expectedRevision);
			notRunning(card);
			const sameColumn = card.column === input.column;
			const current = columnIds(tx, input.column);
			const ids = current.filter((id) => id !== card.id);
			const own = sameColumn ? current.indexOf(card.id) : ids.length;
			// Before itself: it stays where it is.
			const before =
				input.beforeCardId === card.id && sameColumn
					? (ids[own] ?? null)
					: input.beforeCardId;
			const index = insertIndex(tx, ids, before);
			const moved: CardRow = {
				...card,
				column: input.column,
				label: input.column === "finished" ? (card.label ?? "done") : null,
				reviewed: sameColumn ? card.reviewed : false,
				commitPushReported: sameColumn ? card.commitPushReported : false,
				revision: card.revision + 1,
				updatedAt: now(),
			};
			updateCard(tx, moved);
			ids.splice(index, 0, card.id);
			placeColumn(tx, ids);
			if (!sameColumn)
				placeColumn(
					tx,
					columnIds(tx, card.column).filter((id) => id !== card.id),
				);
			bumpBoard(tx);
			return receiptOf("moved", moved);
		});
	}

	function removeInTransaction(
		tx: Database,
		input: KanbanCardRefInput,
		requestId: string,
	): KanbanOutcome {
		return operate(tx, requestId, "remove", input, () => {
			const card = target(tx, input.cardId, input.expectedRevision);
			notRunning(card);
			deleteCard(tx, card.id);
			placeColumn(
				tx,
				columnIds(tx, card.column).filter((id) => id !== card.id),
			);
			bumpBoard(tx);
			return receiptOf("removed", card);
		});
	}

	function boardInTransaction(
		tx: Database,
		view: KanbanViewContext,
	): KanbanBoardView {
		return {
			revision: boardRevision(tx),
			queue: { state: "running", waiting: 0 },
			runnable: view.runnable,
			cards: allCards(tx).map((card) => cardView(card, view)),
			runs: [],
		};
	}

	function cardInTransaction(
		tx: Database,
		cardId: string,
		view: KanbanViewContext,
	): KanbanCardView | null {
		const card = getCard(tx, cardId);
		return card ? cardView(card, view) : null;
	}

	return {
		addInTransaction,
		editInTransaction,
		moveInTransaction,
		removeInTransaction,
		boardInTransaction,
		cardInTransaction,
		receiptInTransaction: (tx: Database, requestId: string) =>
			getReceipt(tx, requestId)?.receipt ?? null,
		board: (view: KanbanViewContext) =>
			options.store.readSnapshot((tx) => boardInTransaction(tx, view)),
	};
}

export type KanbanService = ReturnType<typeof createKanban>;
