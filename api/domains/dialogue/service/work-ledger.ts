import { jstSeconds } from "../../../infrastructure/jst-time";
import type { Database } from "bun:sqlite";
import type { ToolchainCard } from "../../capabilities";
import type { DialogueDeps } from "./context";
import type { PendingConfirmation, TodoItem } from "./work-items";
import { forgetWorkResources, workLinksOf } from "../repository/resources";
import { recordWorkLinksInTransaction } from "./work-links";
import { noticeOf } from "./todo-notices";
import type { TodoNotice } from "../contracts/todo-notices";
import {
	archiveWork,
	archiveWorkNotices,
	dropRunResults,
	forgetWork,
	confirmationById,
	confirmationByRef,
	confirmationRefs,
	insertConfirmation,
	insertWork,
	openConfirmations,
	openWork,
	recentToolchains,
	readWorkNotice,
	recentlyArchivedWork,
	updateWork,
	useConfirmation,
	withdrawConfirmation,
	workByDedupe,
	workById,
	workByRef,
	workBySource,
	workOfRun,
	workNotices,
	workPage,
	workRefs,
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
		ref: row.ref,
		toolchainId: row.toolchainId,
		title: row.title,
		status: row.status,
		...(row.outcome ? { outcome: row.outcome } : {}),
		...(row.status === "waiting" && row.questionId
			? { questionId: row.questionId, question: row.question ?? "" }
			: {}),
	};
}

/** The result fields of a TODO as its owner reported them: the question while waiting, else the result. */
export function resultFields(row: WorkRow): Record<string, unknown> {
	return {
		...(row.outcome ? { outcome: row.outcome } : {}),
		...(row.status === "waiting"
			? { question: row.question }
			: { result: row.result }),
	};
}

/** The TODOs as the conversation sees them, each with the links of the resources it made. */
function itemsOf(db: Database, rows: readonly WorkRow[]): TodoItem[] {
	const links = workLinksOf(
		db,
		rows.map((row) => row.id),
	);
	return rows.map((row) => {
		const made = links.get(row.id);
		return { ...todoOf(row), ...(made ? { links: made } : {}) };
	});
}

/**
 * The numbers the document shows TODOs, confirmations and resources by (section 6 of the layout specification, and
 * `a<n>` of the resource ledger).
 */
function documentRefsInTransaction(
	deps: Pick<DialogueDeps, "resourceLedger">,
	db: Database,
	conversationId: string,
) {
	const todos = workRefs(db, conversationId);
	const confirmations = confirmationRefs(db, conversationId);
	const resources =
		deps.resourceLedger?.numbersInTransaction(db, conversationId) ??
		new Map<string, number>();
	return {
		resource: (uri: string) => {
			const ref = resources.get(uri);
			return ref === undefined ? null : `a${ref}`;
		},
		todo: (todoId: string) => {
			const ref = todos.get(todoId);
			return ref === undefined ? null : `t${ref}`;
		},
		confirmation: (confirmationId: string) => {
			const ref = confirmations.get(confirmationId);
			return ref === undefined ? null : `c${ref}`;
		},
	};
}

/** The message id a TODO's result events stand on besides the request's messages: dropping the result reaches them. */
const resultKey = (workId: string) => `work:${workId}`;

/** The display title of the toolchain a TODO was handed to, as registered now (its revision, else the current one). */
function toolchainTitleOf(
	toolchains: DialogueDeps["toolchains"],
	db: Database,
	row: WorkRow,
): string | undefined {
	if (!toolchains) return undefined;
	const own = toolchains.cardInTransaction(db, row.toolchainRevisionId);
	if (own) return own.title;
	const current = toolchains
		.catalogInTransaction(db)
		.find((entry) => entry.id === row.toolchainId);
	return current
		? toolchains.cardInTransaction(db, current.revisionId)?.title
		: undefined;
}

/** The registered screen of each active toolchain bound to one (`artifact:timers.workspace@2` → `timers.workspace`). */
function toolchainScreens(
	toolchains: DialogueDeps["toolchains"],
	db: Database,
): Map<string, string> {
	const screens = new Map<string, string>();
	for (const entry of toolchains?.catalogInTransaction(db) ?? []) {
		const revision = entry.runtime.binding?.artifactRevisionId;
		const id = revision && /^artifact:(.+)@[0-9]+$/.exec(revision)?.[1];
		if (id) screens.set(entry.id, id);
	}
	return screens;
}

/** What an owner reports into a TODO. */
type WorkReport =
	| { status: "waiting"; questionId: string; question: string }
	| {
			status: "done";
			outcome: WorkOutcome;
			result: unknown;
			/** The resource URIs the sub-agent named as made by the work (`ChildResult.links`). */
			links?: readonly string[];
	  }
	| { status: "todo" };

/** What the finished work made is kept with it (resource plan section 4.1): only a successful or partial end makes any. */
function recordReportLinks(
	deps: Pick<DialogueDeps, "resources" | "resourceLedger">,
	db: Database,
	row: WorkRow,
	report: WorkReport,
) {
	if (
		report.status === "done" &&
		(report.outcome === "succeeded" || report.outcome === "partial")
	)
		recordWorkLinksInTransaction(
			deps,
			db,
			row,
			report.result,
			{ conversationId: row.conversationId, runId: row.runId, workId: row.id },
			report.links,
		);
}

/** What `## State`, the TODO screen and the notices read of finished (archived) work. */
function finishedViews(deps: Pick<DialogueDeps, "clock" | "toolchains">) {
	return {
		/** The TODOs archived since `since` (an ISO time), with their links: what `## State` names as notified. */
		recentlyArchivedInTransaction(
			db: Database,
			conversationId: string,
			since: string,
			limit: number,
		): TodoItem[] {
			return itemsOf(
				db,
				recentlyArchivedWork(db, conversationId, since, limit),
			);
		},
		/** The completion notices of every conversation, newest first, and how many are unread in all. */
		noticesInTransaction(
			db: Database,
			limit: number,
		): { notices: TodoNotice[]; unread: number } {
			const { rows, unread } = workNotices(db, limit);
			const links = workLinksOf(
				db,
				rows.map((row) => row.id),
			);
			const screens = toolchainScreens(deps.toolchains, db);
			return {
				notices: rows.map((row) =>
					noticeOf(
						row,
						links.get(row.id) ?? [],
						toolchainTitleOf(deps.toolchains, db, row),
						screens.get(row.toolchainId),
					),
				),
				unread,
			};
		},
		archiveNoticesInTransaction: (db: Database) =>
			archiveWorkNotices(db, deps.clock()),
		/** Marks a TODO's notice read; false when the TODO has no notice. */
		readNoticeInTransaction: (db: Database, workId: string) =>
			readWorkNotice(db, workId, deps.clock()),
	};
}

/**
 * The conversation's TODO ledger: a TODO per piece of work handed to a toolchain, its state as the work's owner
 * reports it, each reported question or result as an event of the log, the archive as the work finishes with its
 * notice on screen (the TODO completion notice design), and the confirmations issued before executing a change.
 */
export function createWorkLedger(
	deps: Pick<
		DialogueDeps,
		| "clock"
		| "id"
		| "continuity"
		| "toolchains"
		| "resources"
		| "resourceLedger"
	>,
) {
	const { clock, id, continuity } = deps;
	/** A question or result the owner reported joins the log once per revision (the ContextWindow layout specification). */
	function logResult(db: Database, row: WorkRow) {
		if (row.status === "todo") return;
		continuity.events.appendInTransaction(db, {
			conversationId: row.conversationId,
			at: jstSeconds(Date.parse(row.updatedAt)),
			type: "acted",
			by: "host",
			fields: {
				action: "work.result",
				todo: row.id,
				status: row.status,
				...resultFields(row),
			},
			messageIds: [...row.messageIds, resultKey(row.id)],
			dedupeKey: `work-result:${row.id}:${row.revision}`,
		});
	}
	/** The results of these TODOs leave the log (forgotten, or deleted at their owner); a generation that showed them is not adopted. */
	function clearResults(
		db: Database,
		rows: ReadonlyArray<{ id: string; conversationId: string }>,
	) {
		if (rows.length === 0) return;
		continuity.events.forgetMessagesInTransaction(
			db,
			rows.map((row) => resultKey(row.id)),
			clock(),
		);
	}
	return {
		todosInTransaction(db: Database, conversationId: string): TodoItem[] {
			return itemsOf(db, openWork(db, conversationId));
		},
		...finishedViews(deps),
		/** The unarchived TODOs' revisions: what the work tool checks an operation against. */
		todoRevisionsInTransaction: (db: Database, conversationId: string) =>
			openWork(db, conversationId).map((row) => ({
				id: row.id,
				revision: row.revision,
			})),
		/** The unarchived TODOs as the host's other parts see them: the model's view, the toolchain and the request time. */
		hostTodosInTransaction: (db: Database, conversationId: string) =>
			openWork(db, conversationId).map((row) => {
				const title = toolchainTitleOf(deps.toolchains, db, row);
				return {
					...itemsOf(db, [row])[0]!,
					...(title ? { toolchainTitle: title } : {}),
					createdAt: row.createdAt,
				};
			}),
		workInTransaction: workById,
		/** The TODO the model names `t<ref>`. */
		workByRefInTransaction: workByRef,
		confirmationByRefInTransaction: confirmationByRef,
		refsInTransaction: (db: Database, conversationId: string) =>
			documentRefsInTransaction(deps, db, conversationId),
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
		 * overwritten; returns the TODO as it now is, or null when it is gone or already archived. Finished work is
		 * archived at once: the user is told by its notice on screen (none for work the user cancelled), never by the
		 * conversation agent.
		 */
		reportInTransaction(
			db: Database,
			workId: string,
			report: WorkReport,
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
			if (report.status === "done" && report.outcome === "cancelled") {
				archiveWork(db, workId, clock());
				return workById(db, workId)!;
			}
			recordReportLinks(deps, db, workById(db, workId)!, report);
			if (report.status === "done") archiveWork(db, workId, clock());
			const next = workById(db, workId)!;
			logResult(db, next);
			return next;
		},
		/** The agent's check: the TODO as it is now (its result is the check's answer). */
		/** A TODO read again: an archived one too, whose report `## State` still points to. */
		checkInTransaction(db: Database, workId: string): WorkRow | null {
			return workById(db, workId);
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
			return workById(db, workId)!;
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
			return workById(db, workId)!;
		},
		/** One page of the conversation's TODOs for display (the TODO screen). */
		pageInTransaction: workPage,
		/**
		 * Forgetting (section 13): the TODOs that came from a forgotten message lose their texts and are archived,
		 * and their results leave the log.
		 */
		forgetInTransaction(db: Database, messageIds: readonly string[]) {
			const forgotten = forgetWork(db, messageIds, clock());
			// The resources of a forgotten TODO are forgotten with it.
			forgetWorkResources(db, forgotten, clock());
			clearResults(db, forgotten);
		},
		/** A run's results deleted at their owner: the TODOs it fed keep no copy, in the TODO or in the log. */
		dropRunResultsInTransaction(db: Database, runId: string) {
			clearResults(db, dropRunResults(db, runId, clock()));
		},
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
				"id" | "ref" | "issuedAt" | "expiresAt" | "usedAt" | "supersededAt"
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
		/** The user declined the confirmation `c<ref>`: it is closed and can no longer be approved. */
		withdrawConfirmationInTransaction: (
			db: Database,
			conversationId: string,
			ref: number,
		) => withdrawConfirmation(db, conversationId, ref, clock()),
		pendingConfirmationsInTransaction(
			db: Database,
			conversationId: string,
		): PendingConfirmation[] {
			return openConfirmations(db, conversationId, clock()).map((row) => ({
				id: row.id,
				ref: row.ref,
				toolchain: row.toolchainId,
				request: row.request,
				impact: row.impact,
				target: row.targetLabel,
			}));
		},
	};
}
export type WorkLedger = ReturnType<typeof createWorkLedger>;
