import type { Database } from "bun:sqlite";
import type { Purpose } from "../../settings";
import { get, type RequestRow } from "../repository";
import type { Receipt } from "../contracts";

/** The moves of a pending request to a state other than a model answer's acceptance. */
export function createRequestStatus(
	allowed: (db: Database, row: RequestRow) => boolean,
) {
	return {
		rejectControlInTransaction(db: Database, receipt: Receipt, _code: string) {
			db.query(
				"UPDATE inference_requests SET status='rejected' WHERE id=? AND mode='control' AND status='pending'",
			).run(receipt.requestId);
		},
		cancelRequestsInTransaction(db: Database, requestIds: string[]) {
			for (const requestId of requestIds)
				db.query(
					"UPDATE inference_requests SET status='cancelled' WHERE id=? AND status='pending'",
				).run(requestId);
		},
		skipInTransaction(db: Database, subject: string, purpose: Purpose) {
			db.query(
				"UPDATE inference_requests SET status='skipped' WHERE subject=? AND purpose=? AND status='pending'",
			).run(subject, purpose);
		},
		/**
		 * Accepts a pending answer request whose answer the host fixed itself: no model answer was adopted, so no
		 * attempt of it is marked accepted (that absence is the record; earlier rounds of the run may have left
		 * unaccepted attempts).
		 */
		acceptHostAnswerInTransaction(db: Database, requestId: string) {
			const row = get(db, requestId);
			if (
				!row ||
				row.purpose !== "llm" ||
				row.mode !== "answer" ||
				!allowed(db, row) ||
				db
					.query(
						"SELECT 1 FROM inference_attempts WHERE request_id=? AND accepted=1",
					)
					.get(requestId)
			)
				return false;
			return (
				db
					.query(
						"UPDATE inference_requests SET status='accepted' WHERE id=? AND status='pending'",
					)
					.run(requestId).changes === 1
			);
		},
	};
}
