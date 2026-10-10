import type { Database } from "bun:sqlite";
import { hash, toolRuntimeOf } from "../../capabilities";
import type { AdoptedEvidence, AnswerTicket, Report } from "../contracts";
import { get, byRoot, update } from "../repository";
import { isPageRead, isSearch } from "./exploration";
import { validateRequirementAdoption } from "./requirement-verification";
import { active, owner, type RuntimeContext } from "./runtime-context";
import type { TaskOps } from "./task-ops";
import { parentProjection, isNegativeReport } from "./verify-report";

export function createAnswer(ctx: RuntimeContext, ops: TaskOps) {
	const { store, capabilities, tools, now } = ctx.deps;
	const { prepared } = ctx.state;
	const { currentActionPayload } = ops;
	function reportInTransaction(db: Database, taskId: string): Report | null {
		const t = get(db, taskId);
		if (!t) return null;
		const target = t.report_task_id ? get(db, t.report_task_id) : t;
		if (!target || target.report_state !== "available") return null;
		const row = db
			.query("SELECT report_json FROM agent_reports WHERE task_id=?")
			.get(target.id) as { report_json: string } | null;
		return row ? (JSON.parse(row.report_json) as Report) : null;
	}
	function safeRow(db: Database, taskId: string) {
		return db
			.query(
				"SELECT safe_projection_json,safe_projection_digest FROM agent_reports WHERE task_id=?",
			)
			.get(taskId) as {
			safe_projection_json: string | null;
			safe_projection_digest: string | null;
		} | null;
	}
	function prepareAnswerInTransaction(
		db: Database,
		rootRunId: string,
	): AnswerTicket {
		const root = byRoot(db, rootRunId);
		if (!root || root.state !== "ready_for_answer")
			throw new Error("task_not_ready");
		const event = db
			.query(
				"SELECT id FROM agent_events WHERE task_id=? AND state IN ('pending','reserved')",
			)
			.get(root.id) as { id: string } | null;
		if (!event) throw new Error("task_not_ready");
		const p = prepared.get(root.id);
		if (p) capabilities.validateInTransaction(db, p);
		const child = root.report_task_id ? get(db, root.report_task_id) : null;
		const report = reportInTransaction(db, root.id);
		if (
			child &&
			(report?.version === 2 || report?.version === 3) &&
			!tools.validateEvidenceInTransaction(db, owner(child), report.sources)
		)
			throw new Error("evidence_invalidated");
		// Only operational progress reaches the parent on failure, never unverified
		// snippets, page bodies or rejected worker claims.
		const progress =
			root.error_code && root.error_code !== "clarification_required"
				? (
						db
							.query(
								"SELECT id FROM agent_tasks WHERE root_run_id=? AND kind='worker'",
							)
							.all(rootRunId) as { id: string }[]
					).flatMap(
						(task) => tools.invocationsInTransaction?.(db, task.id) ?? [],
					)
				: [];
		const succeeded = (state: string) =>
			state === "succeeded" || state === "partial";
		const searches = progress.filter(
			(item) =>
				item.origin === "tool" && isSearch(toolRuntimeOf(item.toolRevisionId)),
		);
		const reads = progress.filter((item) =>
			isPageRead(toolRuntimeOf(item.toolRevisionId)),
		);
		if (root.report_task_id && !report) throw new Error("report_deleted");
		const safe = child ? safeRow(db, child.id) : null;
		if (child && report)
			validateRequirementAdoption(db, child, report, capabilities);
		return {
			requirementContractDigest:
				report?.version === 3 ? report.requirements.contractDigest : null,
			requirementVerificationDigest:
				report?.version === 3 ? report.requirements.verificationDigest : null,
			projectionDigest: safe?.safe_projection_digest ?? null,
			actionPayload: currentActionPayload(db, root),
			actionFailure:
				!!root.error_code &&
				JSON.parse(root.input_json ?? "{}").timerRequested === true,
			taskId: root.id,
			eventId: event.id,
			revision: root.revision,
			dataEpoch: root.data_epoch,
			reportTaskId: child?.id ?? null,
			reportEpoch: child?.data_epoch ?? null,
			reportDigest: report ? hash(report) : null,
			failureCode:
				root.error_code === "clarification_required" ? null : root.error_code,
			projection: report
				? (safe?.safe_projection_json ??
					JSON.stringify(parentProjection(report)))
				: root.error_code
					? JSON.stringify(
							root.error_code === "clarification_required"
								? {
										clarification: JSON.parse(root.input_json ?? "{}")
											.clarificationQuestion,
									}
								: {
										failure: root.error_code,
										researchProgress: {
											searchAttempts: searches.length,
											searchesSucceeded: searches.filter((item) =>
												succeeded(item.state),
											).length,
											readAttempts: reads.length,
											readsSucceeded: reads.filter((item) =>
												succeeded(item.state),
											).length,
											verifiedReport: false,
										},
									},
						)
					: null,
		};
	}
	function validAnswerInTransaction(db: Database, ticket: AnswerTicket) {
		const t = get(db, ticket.taskId);
		if (
			!t ||
			t.state !== "ready_for_answer" ||
			t.revision !== ticket.revision ||
			t.data_epoch !== ticket.dataEpoch ||
			t.deadline <= now()
		)
			return false;
		try {
			const p = prepared.get(t.id);
			if (p) capabilities.validateInTransaction(db, p);
			// Time fields may advance; authority and state must still match the ticket.
			const state = (payload: string | null | undefined): unknown =>
				payload
					? JSON.parse(payload, (key, value) =>
							key === "serverNow" ||
							key === "observedAt" ||
							key === "remainingSeconds"
								? undefined
								: value,
						)
					: null;
			if (
				hash(state(ticket.actionPayload)) !==
				hash(state(currentActionPayload(db, t)))
			)
				return false;
		} catch {
			return false;
		}
		if (ticket.reportTaskId) {
			const child = get(db, ticket.reportTaskId);
			const report = reportInTransaction(db, ticket.reportTaskId);
			if (
				!child ||
				child.data_epoch !== ticket.reportEpoch ||
				!report ||
				hash(report) !== ticket.reportDigest
			)
				return false;
			if (
				(report.version === 2 || report.version === 3) &&
				!tools.validateEvidenceInTransaction(db, owner(child), report.sources)
			)
				return false;
			try {
				validateRequirementAdoption(db, child, report, capabilities);
				if (
					report.version === 3 &&
					(ticket.requirementContractDigest !==
						report.requirements.contractDigest ||
						ticket.requirementVerificationDigest !==
							report.requirements.verificationDigest)
				)
					return false;
			} catch {
				return false;
			}
			if (
				(safeRow(db, child.id)?.safe_projection_digest ?? null) !==
				ticket.projectionDigest
			)
				return false;
		}
		return true;
	}
	function adoptedEvidence(
		db: Database,
		input: { rootRunId: string; ticketId: string; reportEpoch: number },
	): AdoptedEvidence | null {
		const root = byRoot(db, input.rootRunId);
		if (!root || root.state !== "completed" || !root.report_task_id)
			return null;
		const event = db
			.query(
				"SELECT id,state FROM agent_events WHERE id=? AND task_id=? AND state='consumed'",
			)
			.get(input.ticketId, root.id) as { id: string } | null;
		const child = get(db, root.report_task_id);
		if (
			!event ||
			!child ||
			child.state !== "completed" ||
			root.report_state !== "available" ||
			child.report_state !== "available" ||
			child.data_epoch !== input.reportEpoch
		)
			return null;
		const report = reportInTransaction(db, child.id);
		if (!report || isNegativeReport(report)) return null;
		return {
			rootRunId: root.root_run_id,
			rootTaskId: root.id,
			childTaskId: child.id,
			ticketId: event.id,
			rootDataEpoch: root.data_epoch,
			reportEpoch: child.data_epoch,
			reportDigest: hash(report),
			projectionDigest: safeRow(db, child.id)?.safe_projection_digest ?? null,
			bindingToken: null,
		};
	}
	return {
		reportInTransaction,
		api: {
			prepareAnswerInTransaction,
			validAnswerInTransaction,
			byRootInTransaction: byRoot,
			/**
			 * Host-only: evidence of a consumed, completed answer. Unlike validAnswer this does not
			 * depend on ready_for_answer or on the revision that completion bumped.
			 */
			getAdoptedEvidenceInTransaction: adoptedEvidence,
			/** Re-check previously obtained evidence: deletion, cancel or a report change refuse it. */
			validateAdoptedEvidenceInTransaction(
				db: Database,
				evidence: AdoptedEvidence,
			): boolean {
				const current = adoptedEvidence(db, {
					rootRunId: evidence.rootRunId,
					ticketId: evidence.ticketId,
					reportEpoch: evidence.reportEpoch,
				});
				return (
					!!current &&
					current.rootTaskId === evidence.rootTaskId &&
					current.childTaskId === evidence.childTaskId &&
					current.rootDataEpoch === evidence.rootDataEpoch &&
					current.reportDigest === evidence.reportDigest &&
					current.projectionDigest === evidence.projectionDigest
				);
			},
			pendingEvents: () =>
				store.read(
					(db) =>
						db
							.query(
								"SELECT * FROM agent_events WHERE state='pending' ORDER BY created_at LIMIT 100",
							)
							.all() as { id: string; task_id: string; root_run_id: string }[],
				),
			reserveAnswerInTransaction(db: Database, eventId: string, jobId: string) {
				if (
					db
						.query(
							"UPDATE agent_events SET state='reserved',answer_job_id=? WHERE id=? AND state='pending'",
						)
						.run(jobId, eventId).changes !== 1
				)
					throw new Error("task_changed");
			},
			completeAnswerInTransaction(db: Database, ticket: AnswerTicket) {
				if (!validAnswerInTransaction(db, ticket))
					throw new Error("report_invalidated");
				const root = get(db, ticket.taskId)!;
				update(db, root, "completed", "completed", root.error_code);
				db.query(
					"UPDATE agent_events SET state='consumed',consumed_at=? WHERE id=?",
				).run(now(), ticket.eventId);
			},
			failAnswerInTransaction(db: Database, rootRunId: string, code: string) {
				const t = byRoot(db, rootRunId);
				if (active(t)) update(db, t, "failed", "failed", code);
				db.query(
					"UPDATE agent_events SET state='failed' WHERE root_run_id=? AND state!='consumed'",
				).run(rootRunId);
			},
		},
	};
}
export type Answer = ReturnType<typeof createAnswer>;
