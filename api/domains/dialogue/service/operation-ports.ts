import type { Database } from "bun:sqlite";
import { byId, byRequest, linkAnswer } from "../repository";
import { GENERATE_KIND, type DialogueDeps } from "./context";
import {
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
	/** A finished operation's result as it is now; undefined keeps the reported one (reading again is an aid). */
	function currentResult(db: Database, runId: string): unknown {
		try {
			const payload = deps.agents?.actionPayloadInTransaction(db, runId);
			return payload ? (JSON.parse(payload) as unknown) : undefined;
		} catch {
			return undefined;
		}
	}
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
		/** The conversation's open TODOs (the agency asks what they ask; finished work is told on screen). */
		todosInTransaction: (db: Database, conversationId: string) =>
			deps.work!.hostTodosInTransaction(db, conversationId),
		/**
		 * One page of the conversation's TODOs for display (the TODO screen reads it inside its own read). A finished
		 * TODO shows its result as it is now (a cancel after it finished shows).
		 */
		todoPageInTransaction: (
			db: Database,
			conversationId: string,
			query: Parameters<WorkLedger["pageInTransaction"]>[2],
		) => {
			const page = deps.work!.pageInTransaction(db, conversationId, query);
			return {
				...page,
				rows: page.rows.map((row) => {
					const now =
						row.status === "done" ? currentResult(db, row.runId) : undefined;
					return now === undefined ? row : { ...row, result: now };
				}),
			};
		},
		/** The agency's own utterance (no run), as an event of the conversation. */
		recordSpontaneousInTransaction: (
			db: Database,
			input: Parameters<typeof recordSpontaneousInTransaction>[2],
		) => recordSpontaneousInTransaction(deps, db, input),
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
