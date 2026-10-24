import { jstSeconds } from "../../../infrastructure/jst-time";
import type { Database } from "bun:sqlite";
import type { ToolchainCard } from "../../capabilities";
import type { DialogueDeps } from "./context";
import type { PendingConfirmation, TodoItem } from "./context-document";
import {
	archiveWork,
	dropRunResults,
	forgetWork,
	confirmationById,
	insertConfirmation,
	insertWork,
	openConfirmations,
	openWork,
	recentToolchains,
	requestArchive,
	updateWork,
	useConfirmation,
	waitingArchives,
	workByDedupe,
	workById,
	workBySource,
	workOfRun,
	workPage,
	type ConfirmationRow,
	type WorkOutcome,
	type WorkRow,
	type WorkStatus,
} from "../repository/work";

/** A TODO's title: its request on one line, cut to 60 characters. */
const TITLE_CHARS = 60;
/** How long a confirmation may be approved: the open question lifetime of the command interactions. */
export const CONFIRMATION_TTL_MS = 10 * 60 * 1000;
/** The most recently used toolchains the conversation may delegate to without a search (section 6.2). */
export const RETAINED_LIMIT = 4;

const oneLine = (text: string, max: number) => {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

export function todoOf(row: WorkRow): TodoItem {
	return {
		id: row.id,
		title: row.title,
		status: row.status,
		...(row.outcome ? { outcome: row.outcome } : {}),
		revision: row.revision,
		updatedAt: jstSeconds(Date.parse(row.updatedAt)),
		...(row.status === "waiting" && row.questionId
			? { questionId: row.questionId, question: row.question ?? "" }
			: {}),
	};
}

/** The result fields a TODO's work-result slot holds (`active`), by its state. */
export function activeFields(row: WorkRow): Record<string, unknown> {
	return {
		revision: row.revision,
		...(row.outcome ? { outcome: row.outcome } : {}),
		authority: "host_record",
		...(row.status === "waiting"
			? { questionId: row.questionId, question: row.question }
			: { certainty: "unverified", result: row.result }),
	};
}

/**
 * The conversation's TODO ledger: a TODO per piece of work handed to a toolchain, its state as the work's owner
 * reports it, the result slot in the active short-term memory, the archive in two steps (request, then the delivery
 * that confirms it), and the confirmations issued before executing a change.
 */
export function createWorkLedger(
	deps: Pick<DialogueDeps, "clock" | "id" | "continuity" | "toolchains">,
) {
	const { clock, id, continuity } = deps;
	/** Mirrors the TODO into its `active` slot (waiting: the question; done: the result). */
	function mirror(db: Database, row: WorkRow) {
		// Back in progress (answered, amended): the old question or result leaves the slot.
		if (row.status === "todo") {
			continuity.events.removeActiveInTransaction(
				db,
				row.conversationId,
				row.id,
			);
			return;
		}
		continuity.events.putActiveInTransaction(db, {
			conversationId: row.conversationId,
			todoId: row.id,
			status: row.status,
			at: jstSeconds(Date.parse(row.updatedAt)),
			fields: activeFields(row),
		});
	}
	function clearSlots(
		db: Database,
		rows: ReadonlyArray<{ id: string; conversationId: string }>,
		reason: string,
	) {
		const conversations = new Set<string>();
		for (const row of rows) {
			continuity.events.removeActiveInTransaction(
				db,
				row.conversationId,
				row.id,
			);
			conversations.add(row.conversationId);
		}
		for (const conversationId of conversations)
			continuity.events.bumpWindowInTransaction(
				db,
				conversationId,
				clock(),
				reason,
			);
	}
	return {
		todosInTransaction(db: Database, conversationId: string): TodoItem[] {
			return openWork(db, conversationId).map(todoOf);
		},
		/** The open TODOs as the host's other parts see them: the model's view and when each was requested. */
		hostTodosInTransaction: (db: Database, conversationId: string) =>
			openWork(db, conversationId).map((row) => ({
				...todoOf(row),
				createdAt: row.createdAt,
			})),
		workInTransaction: workById,
		/** Run-centric work the run waits for and that has not finished (task executions run on their own). */
		waitingOfRunInTransaction: (db: Database, runId: string) =>
			workOfRun(db, runId).filter(
				(row) =>
					row.status !== "done" &&
					!row.archivedAt &&
					row.execution !== "task" &&
					row.execution !== "pipeline",
			),
		workOfSourceInTransaction: workBySource,
		/**
		 * Opens a TODO for a delegation. The same key (the utterances handled and the toolchain) is the same TODO: a
		 * repeated call returns it and adds nothing.
		 */
		startInTransaction(
			db: Database,
			input: {
				conversationId: string;
				runId: string;
				card: Pick<ToolchainCard, "id" | "revisionId" | "execution">;
				request: string;
				dedupeKey: string;
				sourceRef?: string;
				/** The user's messages the request comes from (forgetting one clears the TODO). */
				messageIds: readonly string[];
			},
		): { row: WorkRow; created: boolean } {
			const existing = workByDedupe(db, input.conversationId, input.dedupeKey);
			if (existing) return { row: existing, created: false };
			const row = insertWork(db, {
				id: id(),
				conversationId: input.conversationId,
				runId: input.runId,
				toolchainId: input.card.id,
				toolchainRevisionId: input.card.revisionId,
				execution: input.card.execution ?? "agent",
				request: input.request,
				title: oneLine(input.request, TITLE_CHARS),
				sourceRef: input.sourceRef ?? null,
				dedupeKey: input.dedupeKey,
				createdAt: clock(),
				messageIds: input.messageIds,
			});
			return { row, created: true };
		},
		/** Links the TODO to the owner's record (an agent task, an execution, a job) once it exists. */
		linkSourceInTransaction(db: Database, workId: string, sourceRef: string) {
			const row = workById(db, workId);
			if (!row) return false;
			return updateWork(db, workId, row.revision, { sourceRef }, clock());
		},
		/**
		 * The owner reports a state: waiting with a question, or done with an outcome and a result. The result slot is
		 * overwritten; returns the TODO as it now is, or null when it is gone or already archived.
		 */
		reportInTransaction(
			db: Database,
			workId: string,
			report:
				| { status: "waiting"; questionId: string; question: string }
				| { status: "done"; outcome: WorkOutcome; result: unknown }
				| { status: "todo" },
		): WorkRow | null {
			const row = workById(db, workId);
			if (!row || row.archivedAt) return null;
			const patch =
				report.status === "waiting"
					? {
							status: "waiting" as WorkStatus,
							questionId: report.questionId,
							question: report.question,
						}
					: report.status === "done"
						? {
								status: "done" as WorkStatus,
								outcome: report.outcome,
								result: report.result,
								questionId: null,
								question: null,
							}
						: {
								status: "todo" as WorkStatus,
								questionId: null,
								question: null,
							};
			if (!updateWork(db, workId, row.revision, patch, clock())) return null;
			const next = workById(db, workId)!;
			mirror(db, next);
			return next;
		},
		/** The agent's check: the TODO's state and result go to its slot as they are now. */
		checkInTransaction(db: Database, workId: string): WorkRow | null {
			const row = workById(db, workId);
			if (!row || row.archivedAt) return null;
			mirror(db, row);
			return row;
		},
		/** The agent amended the request: the revision moves on. */
		amendInTransaction(
			db: Database,
			workId: string,
			expectedRevision: number,
			request: string,
		): WorkRow | null {
			if (
				!updateWork(
					db,
					workId,
					expectedRevision,
					{ request, status: "todo", questionId: null, question: null },
					clock(),
				)
			)
				return null;
			const next = workById(db, workId)!;
			mirror(db, next);
			return next;
		},
		/** An answer resumes the work in the answering run: the TODO waits with that run, back in `todo`. */
		relinkInTransaction(
			db: Database,
			workId: string,
			runId: string,
		): WorkRow | null {
			const row = workById(db, workId);
			if (
				!row ||
				!updateWork(
					db,
					workId,
					row.revision,
					{ runId, status: "todo", questionId: null, question: null },
					clock(),
				)
			)
				return null;
			const next = workById(db, workId)!;
			mirror(db, next);
			return next;
		},
		/** One page of the conversation's TODOs for display (the TODO screen). */
		pageInTransaction: workPage,
		/**
		 * Forgetting (section 13): the TODOs that came from a forgotten message lose their texts and are archived,
		 * their result slots go, and the window version moves so a generation that showed them is not adopted.
		 */
		forgetInTransaction(db: Database, messageIds: readonly string[]) {
			clearSlots(db, forgetWork(db, messageIds, clock()), "forget");
		},
		/** A run's results deleted at their owner: the TODOs it fed keep no copy, in the TODO or in its slot. */
		dropRunResultsInTransaction(db: Database, runId: string) {
			clearSlots(db, dropRunResults(db, runId, clock()), "result_deleted");
		},
		requestArchiveInTransaction: requestArchive,
		/** Archives a finished TODO and removes its result slot (section 9.4). */
		archiveInTransaction(db: Database, workId: string): boolean {
			const row = workById(db, workId);
			if (!row || !archiveWork(db, workId, clock())) return false;
			continuity.events.removeActiveInTransaction(
				db,
				row.conversationId,
				workId,
			);
			return true;
		},
		waitingArchivesInTransaction: waitingArchives,
		/** The toolchains used most recently, with their one-line summary and the last request (section 6.2). */
		retainedInTransaction(
			db: Database,
			conversationId: string,
		): Array<{ card: ToolchainCard; summary: string; last: string }> {
			return recentToolchains(db, conversationId, RETAINED_LIMIT).flatMap(
				(recent) => {
					const card = deps.toolchains?.cardInTransaction(
						db,
						recent.toolchainRevisionId,
					);
					return card
						? [
								{
									card,
									summary: oneLine(card.summary, 120),
									last: oneLine(recent.request, 120),
								},
							]
						: [];
				},
			);
		},
		issueConfirmationInTransaction(
			db: Database,
			input: Omit<
				ConfirmationRow,
				"id" | "issuedAt" | "expiresAt" | "usedAt" | "supersededAt"
			>,
			messageIds: readonly string[],
		): ConfirmationRow {
			const issuedAt = clock();
			const row = {
				...input,
				id: id(),
				issuedAt,
				expiresAt: new Date(
					Date.parse(issuedAt) + CONFIRMATION_TTL_MS,
				).toISOString(),
			};
			insertConfirmation(db, row, messageIds);
			return confirmationById(db, row.id)!;
		},
		confirmationInTransaction: confirmationById,
		useConfirmationInTransaction: (db: Database, confirmationId: string) =>
			useConfirmation(db, confirmationId, clock()),
		pendingConfirmationsInTransaction(
			db: Database,
			conversationId: string,
		): PendingConfirmation[] {
			return openConfirmations(db, conversationId, clock()).map((row) => ({
				id: row.id,
				toolchain: row.toolchainId,
				request: row.request,
				impact: row.impact,
				expiresAt: row.expiresAt,
			}));
		},
	};
}
export type WorkLedger = ReturnType<typeof createWorkLedger>;
