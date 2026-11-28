import type { Database } from "bun:sqlite";
import type {
	GoalProgress,
	GoalQuestion,
	GoalReplyWorkPort,
	GoalReportV1,
	GoalStore,
} from "eumenes-agency/agenda/runtime";
import type { ConversationService } from "../../domains/conversation";
import type { SqliteStore } from "../../infrastructure/sqlite";
import { cycleOf } from "./goal-deliberation";
import type { GoalWorkPort, GoalWorkView } from "./goal-assignments";
import { goalAccess } from "./goal-progress-context";

const PROGRESS_CHARACTERS = 120;

/**
 * Registered goals as the agency reports them (spec/goal-results-as-assignments-2026-11-26.md): a view of each goal
 * that goes on or has a report to tell, and the user's answer, change and call-off handed to the goal's own
 * operations. Nothing is written to the conversation here: the agent tells it, in its own words.
 */
export function createGoalWork(ports: {
	store: SqliteStore;
	goals: GoalStore;
	conversation: Pick<ConversationService, "sourceInTransaction">;
	blocked(db: Database, messageId: string): boolean;
	enabled?(db: Database): boolean;
	/** The goal operations of a conversation (`update_goal`'s). */
	reply(conversationId: string): GoalReplyWorkPort;
	now?: () => number;
}): GoalWorkPort & { recover(): Promise<void> } {
	const now = ports.now ?? Date.now;
	const { store, goals, conversation } = ports;

	/** A report that may still be told: the goal is met at the report's version and nothing it rests on went. */
	function reportCurrent(db: Database, report: GoalReportV1) {
		const access = goalAccess(report);
		const goal = goals.currentGoalInTransaction(db, access, report.goalId);
		const progress = goals.progressInTransaction(db, access, report);
		return (
			goal?.status === "completed" &&
			goal.revision === report.completedRevision &&
			progress?.phase === "completed" &&
			![
				...(progress.state.sourceRef ? [progress.state.sourceRef] : []),
				...report.evidence.flatMap((item) => item.sources ?? []),
			].some((id) => ports.blocked(db, id))
		);
	}

	function progressOf(db: Database, row: GoalProgress) {
		const step = cycleOf(row).current?.step;
		const doing =
			row.phase === "observing"
				? `実行中: ${step ?? "手順の手"}`
				: row.phase === "verifying"
					? "検査で確かめている"
					: row.phase === "waiting"
						? `待っている（${row.state.watch?.condition ?? row.state.problem ?? "見直しの時刻"}）`
						: row.phase === "needs_user"
							? "回答を待っている"
							: "次の手を考えている";
		const last = [...goals.goalAttemptsInTransaction(db, goalAccess(row), row)]
			.reverse()
			.find(({ outcome }) => outcome !== "reserved" && outcome !== "running");
		return (last?.observed ? `${doing}。直近: ${last.observed}` : doing)
			.replace(/\s+/gu, " ")
			.slice(0, PROGRESS_CHARACTERS);
	}

	/** Until when the goals' own quiet holds the goal's questions back (0: it does not). */
	function quietUntil(db: Database, row: GoalProgress) {
		const control = goals.goalScopeControlInTransaction(
			db,
			goalAccess(row),
			row.ledgerScope,
		);
		return Math.max(control?.speechUntilMs ?? 0, control?.allUntilMs ?? 0);
	}

	/**
	 * A question still to ask: not answered or settled, and still standing on what it rests on (the user's words and
	 * material it cites; a running assignee's question, on that work and its permission still being current).
	 */
	function askable(db: Database, row: GoalProgress, question: GoalQuestion) {
		const at = now();
		if (
			question.answeredBy ||
			question.resolution ||
			(question.owner && question.owner.expiresAtMs <= at)
		)
			return false;
		const access = goalAccess(row);
		const attempt =
			question.owner &&
			goals.goalAttemptInTransaction(db, access, row, question.owner.attemptId);
		const permit =
			question.owner &&
			goals.goalPermitInTransaction(db, access, row, attempt?.permitId);
		if (
			question.owner &&
			(!attempt ||
				attempt.outcome !== "running" ||
				attempt.ownerWorkId !== question.owner.ownerWorkId ||
				!permit ||
				permit.revoked ||
				permit.revision !== attempt.permitRevision ||
				(permit.scope.expiresAtMs ?? Infinity) <= at)
		)
			return false;
		return !(question.inputSources ?? []).some((id) => ports.blocked(db, id));
	}

	/** The goal's open question for the user, once the goals' own quiet lets it be asked. */
	function questionOf(db: Database, row: GoalProgress) {
		if (quietUntil(db, row) > now()) return null;
		const question = row.state.questions.find((item) => askable(db, row, item));
		return question ? { ref: question.ref, prompt: question.question } : null;
	}

	function viewsInTransaction(db: Database): GoalWorkView[] {
		if (ports.enabled?.(db) === false) return [];
		const reports = goals.pendingGoalReportsInTransaction(db);
		return goals.progressRowsInTransaction(db).flatMap((row) => {
			const sourceRef = row.state.sourceRef;
			if (!sourceRef || ports.blocked(db, sourceRef)) return [];
			const source = conversation.sourceInTransaction(db, sourceRef);
			if (source.state !== "available" || source.message.role !== "user")
				return [];
			const access = goalAccess(row);
			const report = reports.find(
				(item) =>
					item.goalId === row.goalId &&
					item.goalRevision === row.goalRevision &&
					reportCurrent(db, item),
			);
			const active = goals.activeProgressInTransaction(db, access, row);
			if (!active && !report) return [];
			const goal = goals.currentGoalInTransaction(db, access, row.goalId);
			const slot = goals
				.listInTransaction(db, access)
				.find((entry) => entry.goal?.goalId === row.goalId)?.slot;
			if (!goal || slot === undefined) return [];
			return [
				{
					goalId: row.goalId,
					revision: row.goalRevision,
					slot,
					text: goal.desiredState,
					conversationId:
						row.deliveryConversationId ?? source.message.conversationId,
					sourceMessageId: sourceRef,
					progress: report ? null : progressOf(db, row),
					question: report ? null : questionOf(db, row),
					report: report
						? {
								id: report.id,
								text: report.text,
								checked: report.evidence.map(({ summary }) =>
									summary.replace(/\s+/gu, " ").slice(0, 300),
								),
								sources: [
									...new Set(
										report.evidence.flatMap(({ sources }) => sources ?? []),
									),
								],
							}
						: null,
				},
			];
		});
	}

	return {
		viewsInTransaction,
		heldUntilInTransaction(db) {
			const at = now();
			const held = goals
				.progressRowsInTransaction(db)
				.filter(
					(row) =>
						goals.activeProgressInTransaction(db, goalAccess(row), row) &&
						row.state.questions.some((item) => askable(db, row, item)),
				)
				.map((row) => quietUntil(db, row))
				.filter((until) => until > at);
			return held.length ? Math.min(...held) : null;
		},
		reportedInTransaction(db, view) {
			const report = goals
				.pendingGoalReportsInTransaction(db)
				.find(({ id }) => id === view.report?.id);
			if (report)
				goals.setGoalReportInTransaction(
					db,
					goalAccess(report),
					report.id,
					"delivered",
				);
		},
		async control({ conversationId, view, action, text, messageId, signal }) {
			const words = store.read((db) =>
				conversation.sourceInTransaction(db, messageId),
			);
			if (words.state !== "available" || words.message.role !== "user")
				throw new Error("utterance_required");
			const user = { id: messageId, text: words.message.text };
			const target = {
				slot: view.slot,
				goalId: view.goalId,
				revision: view.revision,
				design: null,
				priority: null,
				quote: user.text.trim().slice(0, 500) || "（回答）",
			};
			const goal = ports.reply(conversationId);
			if (action === "answer") {
				if (!view.question) throw new Error("goal_question_not_current");
				await goal.update(
					{
						...target,
						action: "answer_question",
						desiredState: null,
						questionRef: view.question.ref,
					},
					user,
					signal,
				);
				return "answered: 登録目標に回答を渡した";
			}
			if (action === "amend") {
				await goal.update(
					{ ...target, action: "revise", desiredState: text },
					user,
					signal,
				);
				return "amended: 登録目標の内容を改めた";
			}
			await goal.update(
				{ ...target, action: "withdraw", desiredState: null },
				user,
				signal,
			);
			return "cancelled: 登録目標を取り下げた";
		},
		/** A report that can no longer be told (what it rests on went) is set aside, never delivered late. */
		async recover() {
			await store.write((db) => {
				for (const report of goals.pendingGoalReportsInTransaction(db))
					if (!reportCurrent(db, report))
						goals.setGoalReportInTransaction(
							db,
							goalAccess(report),
							report.id,
							"invalidated",
						);
			});
		},
	};
}
