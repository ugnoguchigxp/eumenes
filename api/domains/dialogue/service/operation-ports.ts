import type { Database } from "bun:sqlite";
import { byId, byRequest, linkAnswer } from "../repository";
import { GENERATE_KIND, type DialogueDeps } from "./context";
import {
	archiveReportedInTransaction,
	recordHeardInTransaction,
	recordSpontaneousInTransaction,
} from "./delivery-record";
import type { Heard } from "./event-fields";
import { endRun } from "./run-end";
import type { WorkLedger } from "./work-ledger";

/**
 * What the rest of the application tells the conversation and reads of it: notice delivery, the TODOs, the
 * agency's utterances, how much of an answer was heard, the announcement player, and the operations that hand a
 * run's result back to it.
 */
export function createOperationPorts(deps: DialogueDeps) {
	const { clock, queue } = deps;
	return {
		/** A completed notice run delivered it: the TODO carries the news, said now or later by the agent. */
		noticeDeliveryInTransaction(db: Database, requestId: string) {
			const run = byRequest(db, requestId);
			return !run || run.status === "queued" || run.status === "running"
				? ("pending" as const)
				: run.status === "completed"
					? ("delivered" as const)
					: ("failed" as const);
		},
		/**
		 * The conversation's TODOs that are not archived, with their results (the agency reports them). A finished
		 * operation's result is read again as it is now, so a cancel after the report is what the agent says.
		 */
		todosInTransaction: (db: Database, conversationId: string) =>
			deps.work!.hostTodosInTransaction(db, conversationId, (row) => {
				// Reading again is an aid: when the operation cannot be read now, the reported result stands.
				try {
					const payload = deps.agents?.actionPayloadInTransaction(
						db,
						row.runId,
					);
					return payload ? (JSON.parse(payload) as unknown) : undefined;
				} catch {
					return undefined;
				}
			}),
		/** One page of the conversation's TODOs for display (the TODO screen reads it inside its own read). */
		todoPageInTransaction: (
			db: Database,
			conversationId: string,
			query: Parameters<WorkLedger["pageInTransaction"]>[2],
		) => deps.work!.pageInTransaction(db, conversationId, query),
		/** The agency's own utterance (no run), as an event of the conversation. */
		recordSpontaneousInTransaction: (
			db: Database,
			input: Parameters<typeof recordSpontaneousInTransaction>[2],
		) => recordSpontaneousInTransaction(deps, db, input),
		/** The finished TODOs a run's reply reported (found by the agent's background update): archived once heard. */
		archiveReportedInTransaction: (
			db: Database,
			input: Parameters<typeof archiveReportedInTransaction>[2],
		) => archiveReportedInTransaction(deps, db, input),
		/** How much of a run's spoken answer reached the user (the voice playback's report). */
		recordHeardInTransaction: (
			db: Database,
			runId: string,
			heard: Heard,
			spokenText?: string,
		) => recordHeardInTransaction(deps, db, runId, heard, spokenText),
		/** One delivery owner; its disposer cannot remove a newer owner's registration. */
		setAnnouncementDelivery(
			deliver: NonNullable<DialogueDeps["deliverAnnouncement"]>,
		) {
			deps.deliverAnnouncement = deliver;
			return () => {
				if (deps.deliverAnnouncement === deliver)
					deps.deliverAnnouncement = undefined;
			};
		},
		linkOperationJobInTransaction(db: Database, runId: string, jobId: string) {
			linkAnswer(db, runId, jobId);
		},
		finishOperationInTransaction(db: Database, runId: string) {
			const run = byId(db, runId);
			if (!run || !["queued", "running"].includes(run.status)) return;
			if (Date.parse(run.deadlineAt!) <= Date.parse(clock())) {
				endRun(deps, db, run, "failed", "deadline_exceeded");
				return;
			}
			const { job } = queue.enqueueInTransaction(db, {
				scope: "dialogue",
				kind: GENERATE_KIND,
				dedupeKey: `operation-answer:${run.id}`,
				payload: { runId },
				subjectRef: runId,
				lane: "interactive",
				resourceKey: "inference.llm",
				maxAttempts: 1,
				concurrencyKey: `conversation:${run.conversationId}`,
				deadlineAtMs: Date.parse(run.deadlineAt!),
			});
			linkAnswer(db, runId, job.id);
		},
	};
}
