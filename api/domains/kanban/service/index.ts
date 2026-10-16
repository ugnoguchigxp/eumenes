import type { Database } from "bun:sqlite";
import {
	DEFAULT_EXECUTOR_ID,
	type ExecutorRegistry,
} from "../contracts/shared";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import { boardInTransaction, cardInTransaction } from "./board";
import { sharedBoardInTransaction } from "./shared-board";
import { createSharedOperations } from "./shared-operations";
import {
	DEFAULT_PROJECT_ID,
	KANBAN_PROMPT_MAX,
	type KanbanAddInput,
	type KanbanCardRefInput,
	type KanbanEditInput,
	type KanbanMoveInput,
	type KanbanNoticeView,
	type KanbanViewContext,
} from "../contracts";
import { createCore, type Applied, type KanbanOutcome } from "./core";
import { createExecutionOperations, createExecutionAdopter } from "./execution";
import {
	bumpBoard,
	columnIds,
	deleteCard,
	getCard,
	getReceipt,
	insertCard,
	placeColumn,
	rememberExecutor,
	updateCard,
	type CardRow,
} from "../repository";
import { createRecovery } from "./recovery";
import { createRuns } from "./runs";
import { listNotices, markNoticeRead, unreadNotices } from "../repository/runs";

export type { KanbanOutcome } from "./core";
export type { KanbanRecoverPorts } from "./recovery";

const iso = (ms: number) => new Date(ms).toISOString();

/** A card back to a state without any run (todo): nothing of its conversation is kept. */
const NO_RUN: Pick<
	CardRow,
	| "label"
	| "reason"
	| "reviewed"
	| "commitPushReported"
	| "claudeSessionId"
	| "sessionRef"
	| "currentRunId"
	| "lastReport"
	| "files"
> = {
	label: null,
	reason: null,
	reviewed: false,
	commitPushReported: false,
	claudeSessionId: null,
	sessionRef: null,
	currentRunId: null,
	lastReport: null,
	files: [],
};

export function createKanban(options: {
	store: SqliteStore;
	now?: () => number;
	id?: () => string;
	executors?: ExecutorRegistry;
}) {
	const core = createCore({
		now: options.now ?? Date.now,
		newId: options.id ?? (() => crypto.randomUUID()),
		executors: options.executors,
	});
	const { now, newId, operate, target, receiptOf } = core;
	const { pendingStops, stopUnconfirmed, ...runOperations } = createRuns(core);
	const recovery = createRecovery(
		options.store,
		runOperations.finishRunInTransaction,
		now,
	);

	/** A prompt that could be saved but never run is refused when it is saved. */
	function promptFits(prompt: string | undefined) {
		if (prompt !== undefined && prompt.length > KANBAN_PROMPT_MAX)
			throw new Error("kanban_prompt_too_long");
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

	function addInTransaction(
		tx: Database,
		input: KanbanAddInput & { executorId?: string },
		requestId: string,
	): KanbanOutcome {
		return operate(tx, requestId, "add", input, () => {
			promptFits(input.prompt);
			const executor = core.executor(input.executorId ?? DEFAULT_EXECUTOR_ID);
			const ids = columnIds(tx, "todo");
			const index = insertIndex(tx, ids, input.beforeCardId);
			const at = now();
			const card: CardRow = {
				id: newId(),
				revision: 1,
				title: input.title,
				prompt: input.prompt,
				column: "todo",
				...NO_RUN,
				projectId: DEFAULT_PROJECT_ID,
				executorId: executor.id,
				hasExecutionHistory: false,
				position: ids.length,
				createdAt: at,
				updatedAt: at,
			};
			insertCard(tx, card);
			rememberExecutor(tx, executor.id);
			ids.splice(index, 0, card.id);
			placeColumn(tx, ids);
			bumpBoard(tx);
			return { receipt: receiptOf("added", card) };
		});
	}

	function editInTransaction(
		tx: Database,
		input: KanbanEditInput,
		requestId: string,
	): KanbanOutcome {
		return operate(tx, requestId, "edit", input, () => {
			promptFits(input.prompt);
			const card = target(tx, input.cardId, input.expectedRevision);
			notRunning(card);
			const title = input.title ?? card.title;
			const prompt = input.prompt ?? card.prompt;
			// Nothing changes: the revision stays, so a no-op edit never conflicts later.
			if (title === card.title && prompt === card.prompt)
				return { receipt: receiptOf("edited", card) };
			const edited: CardRow = {
				...card,
				title,
				prompt,
				revision: card.revision + 1,
				updatedAt: now(),
			};
			updateCard(tx, edited);
			bumpBoard(tx);
			return { receipt: receiptOf("edited", edited) };
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
				// Back to todo forgets the runs; by hand into finished is a Done by the person.
				...(input.column === "todo" ? NO_RUN : {}),
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
			return { receipt: receiptOf("moved", moved) };
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
			return { receipt: receiptOf("removed", card) };
		});
	}

	/** The person looked at a Done card (the column does not change). */
	function reviewInTransaction(
		tx: Database,
		input: KanbanCardRefInput,
		requestId: string,
	): KanbanOutcome {
		return operate(tx, requestId, "review", input, () => {
			const card = target(tx, input.cardId, input.expectedRevision);
			if (card.label !== "done") throw new Error("kanban_state_invalid");
			if (card.reviewed) return { receipt: receiptOf("reviewed", card) };
			const reviewed: CardRow = {
				...card,
				reviewed: true,
				revision: card.revision + 1,
				updatedAt: now(),
			};
			updateCard(tx, reviewed);
			bumpBoard(tx);
			return { receipt: receiptOf("reviewed", reviewed) };
		});
	}

	/** Done or Blocker back to the end of todo; the run history stays. */
	function resetInTransaction(
		tx: Database,
		input: KanbanCardRefInput,
		requestId: string,
	): KanbanOutcome {
		return operate(tx, requestId, "reset", input, (): Applied => {
			const card = target(tx, input.cardId, input.expectedRevision);
			notRunning(card);
			if (card.column !== "finished") throw new Error("kanban_state_invalid");
			const reset: CardRow = {
				...card,
				...NO_RUN,
				column: "todo",
				revision: card.revision + 1,
				updatedAt: now(),
			};
			updateCard(tx, reset);
			core.appendToColumn(tx, reset, "finished");
			bumpBoard(tx);
			return { receipt: receiptOf("reset", reset) };
		});
	}

	const notices = (tx: Database, limit: number) => ({
		notices: listNotices(tx, limit).map((row): KanbanNoticeView => ({
			id: row.id,
			kind: row.kind,
			...(row.cardId ? { cardId: row.cardId } : {}),
			...(row.runId ? { runId: row.runId } : {}),
			text: row.text,
			read: row.read,
			createdAt: iso(row.createdAt),
		})),
		unread: unreadNotices(tx),
	});

	const service = {
		addInTransaction,
		editInTransaction,
		moveInTransaction,
		removeInTransaction,
		reviewInTransaction,
		resetInTransaction,
		...runOperations,
		...createExecutionOperations(core),
		...createExecutionAdopter(core, runOperations),
		boardInTransaction,
		sharedBoardInTransaction: (tx: Database, view: KanbanViewContext) =>
			sharedBoardInTransaction(tx, view, core.executors),
		cardInTransaction,
		receiptInTransaction: (tx: Database, requestId: string) =>
			getReceipt(tx, requestId)?.receipt ?? null,
		noticesInTransaction: notices,
		board: (view: KanbanViewContext) =>
			options.store.readSnapshot((tx) => boardInTransaction(tx, view)),
		/** Newest first, with the unread count (`GET /api/kanban/notices`). */
		notices: (limit: number) =>
			options.store.readSnapshot((tx) => notices(tx, limit)),
		/** Marks a notice read; `kanban_notice_not_found` when there is none. */
		readNotice: (id: string) =>
			options.store.write((tx) => {
				if (!markNoticeRead(tx, id)) throw new Error("kanban_notice_not_found");
			}),
		/** Runs whose stop the person asked for and that nobody carried out yet. */
		pendingStops: (executorId = DEFAULT_EXECUTOR_ID) =>
			options.store.readSnapshot((tx) => pendingStops(tx, executorId)),
		cardExecutorInTransaction: (tx: Database, cardId: string) => {
			const card = getCard(tx, cardId);
			if (!card) throw new Error("kanban_card_not_found");
			return core.executor(card.executorId);
		},
		/** Records that a stopped run's process could not be confirmed gone. */
		stopUnconfirmed: (runId: string) =>
			options.store.write((tx) => stopUnconfirmed(tx, runId)),
		...recovery,
	};
	return { ...service, ...createSharedOperations(core, service) };
}

export type KanbanService = ReturnType<typeof createKanban>;
