import type { Database } from "bun:sqlite";
import type { GoalReportV1, GoalStore } from "eumenes-agency/agenda/runtime";
import type { ConversationService } from "../../domains/conversation";
import type { MemoryService } from "../../domains/memory";
import type { SqliteStore } from "../../infrastructure/sqlite";
import { recordPrefix, type AgencyRecordInputDeps } from "./input";
import { captureGoalSources } from "./goal-input-sources";
import { goalAccess } from "./goal-progress-context";
import { pendingGoalQuestions } from "./goal-question-delivery";

export function createGoalReportDelivery(ports: {
	store: SqliteStore;
	goals: GoalStore;
	conversation: Pick<
		ConversationService,
		"sourceInTransaction" | "appendInTransaction"
	>;
	referenceInputs: MemoryService["referenceInputs"];
	records?: AgencyRecordInputDeps;
	blocked(db: Database, messageId: string): boolean;
	enabled?(db: Database): boolean;
	now?: () => number;
}) {
	const now = ports.now ?? Date.now;
	const { store, goals, conversation } = ports;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let scheduledAt: number | undefined;
	let unsubscribe: (() => void) | undefined;
	let delivering: Promise<void> | null = null;
	const accessFor = (report: GoalReportV1) => goalAccess(report);
	const pendingReports = (db: Database) =>
		goals
			.pendingGoalReportsInTransaction(db)
			.filter((report) => report.deliveryConversationId !== null);
	function due(db: Database, report: GoalReportV1) {
		const control = goals.goalScopeControlInTransaction(
			db,
			accessFor(report),
			report.ledgerScope,
		);
		return Math.max(control?.speechUntilMs ?? 0, control?.allUntilMs ?? 0);
	}
	function deliver(db: Database, report: GoalReportV1) {
		const access = accessFor(report);
		if (!report.deliveryConversationId || due(db, report) > now()) return;
		const goal = goals.currentGoalInTransaction(db, access, report.goalId);
		const progress = goals.progressInTransaction(db, access, report);
		const sources = [
			...new Set([
				...(progress?.state.sourceRef ? [progress.state.sourceRef] : []),
				...report.evidence.flatMap((item) => item.sources ?? []),
			]),
		];
		if (
			goal?.status !== "completed" ||
			goal.revision !== report.completedRevision ||
			progress?.phase !== "completed" ||
			sources.some((id) => ports.blocked(db, id))
		) {
			goals.setGoalReportInTransaction(db, access, report.id, "invalidated");
			return;
		}
		const id = `agency-goal-report:${report.id}`;
		const prior = conversation.sourceInTransaction(db, id);
		if (prior.state === "missing") {
			// Completion itself advanced this goal's accepted version, which was verified above.
			const originalGoal =
				recordPrefix +
				JSON.stringify([
					"goal",
					report.goalId,
					report.goalRevision,
					report.ledgerScope,
				]);
			const input = captureGoalSources(
				db,
				ports.referenceInputs,
				sources.filter((id) => id !== originalGoal),
				ports.records,
			);
			if (!input.complete) {
				goals.setGoalReportInTransaction(db, access, report.id, "invalidated");
				return;
			}
			conversation.appendInTransaction(db, {
				id,
				conversationId: report.deliveryConversationId,
				role: "assistant",
				text: report.text,
				createdAt: new Date(now()).toISOString(),
				runId: null,
			});
			ports.referenceInputs.recordMessageInTransaction(db, id, input);
		}
		goals.setGoalReportInTransaction(db, access, report.id, "delivered");
	}
	function flush() {
		if (delivering) return delivering;
		delivering = store
			.write((db) => {
				for (const report of pendingReports(db)) deliver(db, report);
				const at = now();
				for (const { input, due, ...question } of pendingGoalQuestions(
					db,
					ports,
					at,
				)) {
					if (due > at) continue;
					conversation.appendInTransaction(db, {
						...question,
						role: "assistant",
						createdAt: new Date(at).toISOString(),
						runId: null,
					});
					ports.referenceInputs.recordMessageInTransaction(
						db,
						question.id,
						input,
					);
				}
			})
			.finally(() => {
				delivering = null;
				if (unsubscribe) schedule();
			});
		return delivering;
	}
	function schedule() {
		if (delivering) return;
		const next = store.read((db) =>
			Math.min(
				...pendingReports(db).map((report) => due(db, report)),
				...pendingGoalQuestions(db, ports, now()).map(
					(question) => question.due,
				),
			),
		);
		const at = Math.max(now() + 1_000, next);
		if (
			timer &&
			scheduledAt !== undefined &&
			scheduledAt <= at &&
			next < Infinity
		)
			return;
		if (timer) clearTimeout(timer);
		timer = undefined;
		scheduledAt = undefined;
		if (next < Infinity) {
			scheduledAt = at;
			timer = setTimeout(() => {
				timer = undefined;
				scheduledAt = undefined;
				void flush().catch(() => {});
			}, at - now());
			timer.unref();
		}
	}

	return {
		recover: flush,
		start() {
			unsubscribe = store.onCommit(schedule);
			schedule();
		},
		async close() {
			unsubscribe?.();
			unsubscribe = undefined;
			if (timer) clearTimeout(timer);
			await delivering;
		},
	};
}
