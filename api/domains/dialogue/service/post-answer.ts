import type { AnswerTicket } from "../../agent-runtime";
import type { Tx } from "../../queue";
import type { PostAnswerObserverPort } from "../contracts";
import { getLogger } from "../../../infrastructure/logger";
const log = getLogger("dialogue");

/** Optional learning has its own SAVEPOINT; failure never undoes an adopted answer. */
export function observeAnswer(
	postAnswer: PostAnswerObserverPort | undefined,
	tx: Tx,
	runId: string,
	ticket?: AnswerTicket,
) {
	if (!postAnswer || !ticket || ticket.reportEpoch === null) return;
	const name = "dialogue_post_answer";
	tx.exec(`SAVEPOINT ${name}`);
	try {
		const result = postAnswer.recordInTransaction(tx, {
			runId,
			ticketId: ticket.eventId,
			reportEpoch: ticket.reportEpoch,
		});
		if (result.status !== "recorded") {
			tx.exec(`ROLLBACK TO ${name}`);
			log.info("dialogue.post_answer_skipped", { reason: result.code });
		}
	} catch {
		tx.exec(`ROLLBACK TO ${name}`);
		log.warn("dialogue.post_answer_skipped", { reason: "observer_error" });
	}
	tx.exec(`RELEASE ${name}`);
}
