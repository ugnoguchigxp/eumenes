import type { Database } from "bun:sqlite";
import { z, ZodError } from "zod";
import type { Project } from "../domains/dots";
import type { TasksService, WorkTask } from "../domains/tasks";

export const TASKS = "query:dots.tasks@1";
export const TASK_PROJECT_OPTIONS = "query:dots.task-project-options@1";
export const TASK_QUERIES = [TASKS, TASK_PROJECT_OPTIONS] as const;
export const TASK_OPERATIONS = [
	["dots.task-create", "schema:dots-task-create@1"],
	["dots.task-start", "schema:dots-task-command@1"],
	["dots.task-stop", "schema:dots-task-stop@1"],
	["dots.task-answer", "schema:dots-task-answer@1"],
	["dots.task-forget", "schema:dots-task-command@1"],
] as const;

/** The tasks domain's public transaction operations the delegated-work list drives. */
export type DotsTaskPorts = Pick<
	TasksService,
	| "createInTransaction"
	| "requestStartInTransaction"
	| "requestStopInTransaction"
	| "answerInTransaction"
	| "forgetInTransaction"
	| "getInTransaction"
	| "openQuestionInTransaction"
	| "listInTransaction"
>;

const identifier = z.string().min(1).max(160);
const revision = z.number().int().min(0);
const create = z.strictObject({
	projectRef: identifier,
	title: z.string().max(120),
	request: z.string().max(8000),
	completionConditions: z.string().max(8000),
	maxSessions: z.number().int().min(1).max(20).optional(),
});
const command = z.strictObject({ id: identifier, expectedRevision: revision });
const stop = command.extend({ intent: z.enum(["pause", "cancel"]) });
const answer = command.extend({
	questionId: identifier,
	answer: z.string().min(1).max(8192),
});

export const stateLabels: Record<WorkTask["state"], string> = {
	registered: "登録済み",
	queued: "受領待ち",
	active: "作業中",
	waiting_user: "回答待ち",
	paused: "一時停止",
	reconciling: "再開状況を確認中",
	stopping: "停止確認待ち",
	completed: "完了報告あり",
	failed: "失敗報告あり",
	cancelled: "取消済み",
};
const TERMINAL = new Set(["completed", "failed", "cancelled"]);
/** Delegated work lives two hours from the request, as on the legacy screen. */
const LIFETIME_MS = 2 * 60 * 60 * 1000;
const shorten = (value: string | null, max: number) =>
	!value ? "" : value.length > max ? `${value.slice(0, max)}…` : value;

type Orchestration = Extract<WorkTask, { kind: "orchestration" }>;
const isOrchestration = (
	task: WorkTask | null | undefined,
): task is Orchestration => task?.kind === "orchestration";

/** Rows of the delegated work: the task, what it asks, and which commands it accepts now. */
export function taskRows(ports: DotsTaskPorts, tx: Database, nowMs: number) {
	const tasks = ports
		.listInTransaction(tx)
		.filter(isOrchestration)
		.slice(0, 50);
	return {
		revision: tasks.reduce((n, t) => n + t.revision, tasks.length),
		data: tasks.map((t) => {
			const question =
				t.state === "waiting_user"
					? ports.openQuestionInTransaction(tx, t.id)
					: null;
			const valid = Date.parse(t.grant.expiresAt) > nowMs;
			const live = !TERMINAL.has(t.state);
			return {
				id: t.id,
				title: t.title,
				state: t.state,
				stateLabel: stateLabels[t.state],
				revision: t.revision,
				request: shorten(t.request, 400),
				result: t.result?.summary ?? "",
				question: question
					? question.answerType === "choice"
						? `${question.prompt}（選択肢: ${question.choices.join(" / ")}）`
						: question.prompt
					: "",
				questionId: question?.id ?? "",
				updatedAt: t.updatedAt,
				canStart: ["registered", "paused"].includes(t.state) && valid,
				canPause: live && !["stopping", "paused"].includes(t.state),
				canCancel: live && t.stopIntent !== "cancel",
				canAnswer: !!question && valid,
				canForget: t.forgottenAt === null,
			};
		}),
	};
}

/** Projects a task can be requested for: enabled, on an enabled connection. */
export function taskProjectOptions(
	projects: Project[],
	enabledConnections: ReadonlySet<string>,
) {
	return {
		revision: 0,
		data: {
			options: projects
				.filter((p) => p.enabled && enabledConnections.has(p.connectionRef))
				.map((p) => ({ value: p.ref, label: p.title })),
		},
	};
}

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
	const parsed = schema.safeParse(input);
	if (!parsed.success) throw new Error("invalid_input");
	return parsed.data;
}
/** A task this screen may command: delegated work only, never another kind of task. */
function owned(ports: DotsTaskPorts, tx: Database, id: string) {
	const task = ports.getInTransaction(tx, id);
	if (!isOrchestration(task)) throw new Error("task_not_found");
	return task;
}

/**
 * One delegated-work command. The ledger's event id is the task domain's request id, so a
 * resend is that domain's own replay; revisions are the ones the row carried.
 */
export function runTaskOperation(
	ports: DotsTaskPorts,
	tx: Database,
	input: {
		operation: string;
		data: unknown;
		requestId: string;
		nowMs: number;
		projects: Project[];
		enabledConnections: ReadonlySet<string>;
	},
) {
	const { requestId } = input;
	try {
		const receipt = (() => {
			switch (input.operation) {
				case "dots.task-create": {
					const data = parse(create, input.data);
					const project = input.projects.find((p) => p.ref === data.projectRef);
					if (
						!project?.enabled ||
						!input.enabledConnections.has(project.connectionRef)
					)
						throw new Error("dots_unavailable");
					const conditions = data.completionConditions
						.split("\n")
						.map((line) => line.trim())
						.filter(Boolean);
					return ports.createInTransaction(tx, {
						kind: "orchestration",
						version: 1,
						requestId,
						title: data.title,
						request: data.request,
						completionConditions: conditions,
						startMode: "start",
						grant: {
							connectionRef: project.connectionRef,
							projectRef: project.ref,
							operations: project.allowedOperations,
							maxSessions: data.maxSessions ?? 1,
							expiresAt: new Date(input.nowMs + LIFETIME_MS).toISOString(),
						},
					});
				}
				case "dots.task-start": {
					const data = parse(command, input.data);
					owned(ports, tx, data.id);
					return ports.requestStartInTransaction(tx, data.id, {
						requestId,
						expectedRevision: data.expectedRevision,
					});
				}
				case "dots.task-stop": {
					const data = parse(stop, input.data);
					owned(ports, tx, data.id);
					return ports.requestStopInTransaction(tx, data.id, {
						requestId,
						expectedRevision: data.expectedRevision,
						intent: data.intent,
					});
				}
				case "dots.task-answer": {
					const data = parse(answer, input.data);
					owned(ports, tx, data.id);
					return ports.answerInTransaction(tx, data.id, {
						requestId,
						expectedRevision: data.expectedRevision,
						questionId: data.questionId,
						answer: data.answer,
					});
				}
				case "dots.task-forget": {
					const data = parse(command, input.data);
					owned(ports, tx, data.id);
					return ports.forgetInTransaction(tx, data.id, {
						requestId,
						expectedRevision: data.expectedRevision,
					});
				}
				default:
					return null;
			}
		})();
		return receipt && { version: 1, kind: "task", ...receipt };
	} catch (error) {
		if (error instanceof ZodError) throw new Error("invalid_input");
		throw error;
	}
}
