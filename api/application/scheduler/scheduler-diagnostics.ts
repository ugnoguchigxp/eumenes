import type { Database } from "bun:sqlite";
import type { AppDevelopment } from "../../domains/app-development";
import type { DiagnosticsPort, DiagnosticScope } from "../../domains/dialogue";
import {
	workflowRunInTransaction,
	workflowScheduleInTransaction,
} from "../../domains/pipelines";
import type { QueueService } from "../../domains/queue";
import type { SchedulerService } from "../../domains/scheduler";
import type { ScheduleDto } from "../../domains/scheduler/contracts";

const PROMPT = "dialogue.prompt";
const WORKFLOW = "workflow.run";
const APP_ARTIFACT = "artifact:app-development.studio@2";
const SCHEDULES = 5;
const OCCURRENCES = 3;

const reason = (value: string | null | undefined) =>
	value && /^[a-z][a-z0-9_]{0,79}(?: \(\+\d+ earlier\))?$/u.test(value)
		? value
		: value
			? "detail_unavailable"
			: null;

export function createSchedulerDiagnostics(deps: {
	scheduler: SchedulerService;
	queue: QueueService;
	apps?: Pick<AppDevelopment, "scope" | "app">;
}): DiagnosticsPort {
	const { scheduler, queue, apps } = deps;
	function job(db: Database, id: string | null) {
		if (!id) return null;
		const saved = queue.getInTransaction(db, id);
		return {
			id,
			state: saved?.state ?? "unavailable",
			reason: reason(saved?.errorCode),
		};
	}
	function conversationResult(
		scope: DiagnosticScope,
		scheduleId: string,
		occurrenceId: string,
		id: string,
	) {
		const run = scope.run(id);
		if (
			!run ||
			run.scheduleId !== scheduleId ||
			run.occurrenceId !== occurrenceId
		)
			return null;
		return {
			id: run.id,
			state: run.status,
			reason: reason(run.error),
			answerSaved: scope.answerSaved(run),
			jobId: run.jobId,
		};
	}
	return {
		readInTransaction(db, scope, target) {
			const { viewing } = scope;
			const app =
				apps &&
				viewing &&
				"artifactRevisionId" in viewing &&
				viewing.artifactRevisionId === APP_ARTIFACT
					? apps.app(db, viewing.targetRef)
					: null;
			const promptTarget = {
				kind: PROMPT,
				key: "conversationId",
				value: scope.conversationId,
			};
			const requested = target.id
				? scheduler.getInTransaction(db, target.id)
				: null;
			const candidates = target.id
				? requested
					? [requested]
					: []
				: [
						...(app
							? scheduler.schedulesForTargetInTransaction(
									db,
									{ kind: WORKFLOW, key: "definitionId", value: app.appId },
									SCHEDULES + 1,
								)
							: []),
						...scheduler.schedulesForTargetInTransaction(
							db,
							promptTarget,
							SCHEDULES + 1,
						),
					].filter((row): row is ScheduleDto => !!row);
			function readable(row: ScheduleDto) {
				const payload = row.targetPayload as {
					conversationId?: string;
					definitionId?: string;
					revision?: number;
				} | null;
				if (row.targetKind === WORKFLOW) {
					const binding =
						app &&
						apps &&
						workflowScheduleInTransaction(
							db,
							apps.scope,
							app.appId,
							row.id,
							true,
						);
					return (
						!!app &&
						!!binding &&
						payload?.definitionId === app.appId &&
						payload.revision === binding.definition_revision
					);
				}
				if (
					row.targetKind !== PROMPT ||
					payload?.conversationId !== scope.conversationId
				)
					return false;
				// Conversation registration uses the user run ID as its request ID. If that source still exists,
				// the dialogue port checks its current authority before the reservation is shown.
				return scope.registrationVisible(row.requestId);
			}
			const visible = candidates.filter(readable);
			const limited =
				visible.length > SCHEDULES || candidates.length > SCHEDULES;
			const items = visible.slice(0, SCHEDULES).map((row) => {
				const history = scheduler.occurrencesInTransaction(
					db,
					row.id,
					OCCURRENCES + 1,
					target.at,
				);
				return {
					id: row.id,
					kind: row.targetKind === PROMPT ? "conversation_reply" : "workflow",
					state: row.state,
					anchorAt: row.anchorAt,
					intervalMs: row.intervalMs,
					nextDueAt: row.state === "active" ? row.nextDueAt : null,
					deferReason: reason(row.deferReason),
					historyLimited: history.length > OCCURRENCES,
					occurrences: history.slice(0, OCCURRENCES).map((o) => {
						const workflow =
							o.subjectRef && row.targetKind === WORKFLOW && apps
								? workflowRunInTransaction(db, apps.scope, o.subjectRef)
								: null;
						const workflowCode = (workflow?.result as { code?: unknown } | null)
							?.code;
						const result =
							o.subjectRef && row.targetKind === PROMPT
								? conversationResult(scope, row.id, o.id, o.subjectRef)
								: workflow &&
									  workflow.workflowId === app?.appId &&
									  workflow.revision ===
											(row.targetPayload as { revision?: number }).revision
									? {
											id: workflow.runId,
											state: workflow.state,
											reason: reason(
												typeof workflowCode === "string" ? workflowCode : null,
											),
											resultSaved:
												workflow.state === "completed" &&
												workflow.result !== null,
											publicationRecorded: workflow.publication !== null,
											jobId: workflow.jobId,
										}
									: null;
						return {
							id: o.id,
							scheduledAt: o.scheduledAt,
							state: o.state,
							reason: reason(o.reason),
							job: job(db, o.jobId),
							result,
							...(result?.jobId && result.jobId !== o.jobId
								? { laterJob: job(db, result.jobId) }
								: {}),
						};
					}),
				};
			});
			return {
				coverage:
					!app || limited || items.some((item) => item.historyLimited)
						? "partial"
						: "complete",
				scope: {
					conversation: "current_conversation",
					workflow: app ? "current_app_only" : "unverified",
					conversationSchedules: limited ? "limited" : "retained_records_only",
					...(target.at ? { scheduledAt: target.at } : {}),
					...(limited ? { scheduleLimit: String(SCHEDULES) } : {}),
					history: "retained_records_only",
				},
				items,
			};
		},
	};
}
