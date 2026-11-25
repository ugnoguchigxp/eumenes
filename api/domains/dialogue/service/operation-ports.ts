import type { Database } from "bun:sqlite";
import { byRequest } from "../repository";
import type { DialogueDeps } from "./context";
import {
	recordHeardInTransaction,
	recordSpontaneousInTransaction,
	recordUnadoptedSpeechInTransaction,
} from "./delivery-record";
import type { Heard } from "./event-fields";

/**
 * What the rest of the application tells the conversation and reads of it: notice delivery, the agency's
 * utterances, how much of an answer was heard, and the announcement player.
 */
export function createOperationPorts(deps: DialogueDeps) {
	return {
		/** A completed notice run delivered it. */
		noticeDeliveryInTransaction(db: Database, requestId: string) {
			const run = byRequest(db, requestId);
			return !run || run.status === "queued" || run.status === "running"
				? ("pending" as const)
				: run.status === "completed"
					? ("delivered" as const)
					: ("failed" as const);
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
		/** What was heard of a run that kept no answer: it joins the chat and the record as the agent's words. */
		recordUnadoptedSpeechInTransaction: (
			db: Database,
			runId: string,
			heardText: string,
		) => recordUnadoptedSpeechInTransaction(deps, db, runId, heardText),
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
	};
}
