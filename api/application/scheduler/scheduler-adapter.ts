import type { Database } from "bun:sqlite";
import { validators } from "../../domains/capabilities";
import type { CollaborationWorks } from "../../domains/collaboration";
import type { SchedulerService } from "../../domains/scheduler";
import type { ScheduleDto } from "../../domains/scheduler/contracts";
import type { AdapterResult, DomainAdapter } from "../../domains/tool-runtime";
import { sha256Hex } from "../../infrastructure/digest";

export const SCHEDULER_ADAPTER_REF = "adapter:scheduler@1";
const LIST = "query:scheduler.pending@1";
const REGISTER = "scheduler.register";
const PROMPT = "dialogue.prompt";

export const describeSchedulerAdapter = () => ({
	owner: "scheduler",
	operations: new Map([
		[
			REGISTER,
			{ inputSchemaRef: "builtin:schedulePrompt", effect: "write" as const },
		],
	]),
	queries: new Set([LIST]),
	inputAdapters: new Map(),
	projections: new Set<string>(),
	availability: "availability:scheduler@1",
});

function registered(schedule: ScheduleDto, replay: boolean): AdapterResult {
	const receipt = {
		id: schedule.id,
		at: schedule.anchorAt,
		intervalMs: schedule.intervalMs,
	};
	return {
		receipt,
		receiptRef: {
			owner: "scheduler",
			operationId: schedule.requestId,
			digest: sha256Hex(JSON.stringify(receipt)),
		},
		resultRefs: [],
		replay,
		answerContext: { ...receipt, nextDueAt: schedule.nextDueAt },
	};
}

type WorkflowTitle = (db: Database, id: string) => string | undefined;
export type SchedulerAdapterPorts = {
	scheduler: SchedulerService;
	workflowTitle?: WorkflowTitle;
};

function intervalLabel(ms: number | null) {
	if (ms === null) return "一回";
	const units = [
		[86_400_000, "日"],
		[3_600_000, "時間"],
		[60_000, "分"],
		[1000, "秒"],
	] as const;
	const [unit, label] = units.find(([size]) => ms % size === 0) ?? [
		1,
		"ミリ秒",
	];
	return `${ms / unit}${label}ごと`;
}

function pendingRows(
	db: Database,
	scheduler: SchedulerService,
	workflowTitle?: WorkflowTitle,
) {
	return scheduler
		.pendingInTransaction(db)
		.sort(
			(a, b) =>
				a.state.localeCompare(b.state) ||
				a.nextDueAt.localeCompare(b.nextDueAt),
		)
		.flatMap((schedule) => {
			const payload = schedule.targetPayload as {
				text?: string;
				definitionId?: string;
			};
			const isPrompt = schedule.targetKind === PROMPT;
			if (!isPrompt && schedule.targetKind !== "workflow.run") return [];
			const title = isPrompt
				? (payload.text?.replace(/\s+/g, " ") ?? "会話の予約")
				: ((payload.definitionId &&
						workflowTitle?.(db, payload.definitionId)) ??
					"ワークフロー");
			return [
				{
					id: schedule.id,
					title: title.length > 180 ? `${title.slice(0, 179)}…` : title,
					kind: isPrompt ? "会話" : "ワークフロー",
					state: schedule.state,
					status: schedule.state === "paused" ? "一時停止" : "予約済み",
					nextDueAt: schedule.state === "active" ? schedule.nextDueAt : null,
					interval: intervalLabel(schedule.intervalMs),
				},
			];
		});
}

export function createSchedulerAdapter(
	{ scheduler, workflowTitle }: SchedulerAdapterPorts,
	works: CollaborationWorks,
): DomainAdapter {
	return {
		ref: SCHEDULER_ADAPTER_REF,
		describe: describeSchedulerAdapter,
		availableInTransaction: () => true,
		snapshotInTransaction: () => null,
		invokeInTransaction(db, request) {
			const { origin } = request;
			if (origin.kind !== "specialist" || request.operationName !== REGISTER)
				throw new Error("specialist_origin_required");
			const source = works.sourceOfTurn(
				db,
				"schedule",
				origin.workRef,
				origin.sessionId,
				origin.runId,
			);
			const { text, at, intervalMs } = validators.schedulePrompt.parse(
				request.input,
			);
			// The shared specialist host may issue several invocations per turn. Only one reservation
			// may commit for its user run, including recovery after the receipt was lost.
			const requestId = source.runId;
			const prior = scheduler.getByRequestInTransaction(db, requestId);
			if (!prior && Date.parse(at) <= Date.parse(request.issuedAt))
				throw new Error("schedule_time_not_future");
			const schedule = scheduler.createInTransaction(db, {
				requestId,
				target: {
					kind: PROMPT,
					payload: { conversationId: source.conversationId, text },
				},
				schedule:
					intervalMs === undefined
						? { type: "once", at }
						: { type: "interval", anchor: at, intervalMs },
				misfirePolicy: "coalesce",
				graceMs: 300_000,
			});
			return registered(schedule, !!prior);
		},
		readInTransaction(db, operationId) {
			const schedule = scheduler.getByRequestInTransaction(db, operationId);
			return schedule?.targetKind === PROMPT
				? registered(schedule, true)
				: null;
		},
		sourceInTransaction(db, query) {
			return query === LIST
				? {
						revision: 0,
						data: { items: pendingRows(db, scheduler, workflowTitle) },
					}
				: null;
		},
		targetInput: () => ({}),
		afterCommit: scheduler.wake,
		session: {
			openInTransaction: (db, input) =>
				works.open(db, "schedule", input.sessionId, input.targetRef),
			stateInTransaction: works.state,
			hasTargetInTransaction: () => false,
			beginTurnInTransaction: works.begin,
			endTurnInTransaction: works.release,
			endInTransaction: works.end,
		},
	};
}
