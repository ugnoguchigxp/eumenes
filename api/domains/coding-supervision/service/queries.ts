import type { Database } from "bun:sqlite";
import { live } from "./policy";
import * as repo from "../repository";
import { approvalView } from "./approval";
import type { SupervisionContext } from "./context";

/** Read-only views over the supervisor state. */
export function createQueries(ctx: SupervisionContext) {
	const { store, tasks, now } = ctx;
	const isApprovalAnswerInTransaction = (
		db: Database,
		taskId: string,
		questionId: string,
	) => repo.get(db, taskId)?.pendingApproval?.questionId === questionId;
	return {
		get(taskId: string) {
			return store.readSnapshot((db) => {
				const t = tasks().getInTransaction(db, taskId);
				if (!t) throw new Error("task_not_found");
				if (t.bodyExpired) throw new Error("task_history_expired");
				const s = repo.get(db, taskId);
				if (!s) return null;
				const {
					observation: _o,
					checks: _c,
					review: _r,
					commit: _g,
					push: _p,
					blockerAttempts: _b,
					pendingApproval: _a,
					...view
				} = s;
				return {
					...view,
					pendingApproval: approvalView(s),
					diagnosticDue:
						live(t, now()) &&
						s.lastProgressAt !== null &&
						now() - s.lastProgressAt >= 300_000,
				};
			});
		},
		/** True for the user's answer to an approval question: it must not reach the CLI as text. */
		isApprovalAnswer(taskId: string, questionId: string) {
			return store.readSnapshot((db) =>
				isApprovalAnswerInTransaction(db, taskId, questionId),
			);
		},
		/** Same check inside an open (write) transaction, where readSnapshot cannot be used. */
		isApprovalAnswerInTransaction,
	};
}
