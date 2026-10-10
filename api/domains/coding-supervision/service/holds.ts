import type { Database } from "bun:sqlite";
import type { WorkTask } from "../../tasks";
import type { Supervisor } from "../contracts";
import { fence, stopped } from "./policy";
import type { SupervisionContext } from "./context";

/** The two ways supervision stops acting: a silent hold, or a question to the user. */
export function createHolds(ctx: SupervisionContext) {
	const { tasks, report } = ctx;
	function hold(db: Database, t: WorkTask, s: Supervisor, reason: string) {
		if (s.holdReason === reason) return;
		s.holdReason = reason;
		report(
			db,
			t,
			s,
			"monitoring_issue",
			"監督の処理を停止しました。状況の確認が必要です。",
			`hold:${reason}:${s.fingerprint ?? "initial"}`,
		);
	}
	function escalate(db: Database, t: WorkTask, s: Supervisor, reason: string) {
		if (!stopped(s)) {
			hold(db, t, s, "supervision_stop_unconfirmed");
			return;
		}
		const questionId = `supervision:${t.id}:${crypto.randomUUID()}`;
		tasks().askInTransaction(db, fence(t), {
			questionId,
			prompt: reason.slice(0, 2000),
			answerType: "text",
			choices: [],
		});
		const updated = tasks().getInTransaction(db, t.id)!;
		report(
			db,
			updated,
			s,
			"blocker",
			reason.slice(0, 600),
			`blocker:${questionId}`,
		);
	}
	return { hold, escalate };
}
export type Holds = ReturnType<typeof createHolds>;
