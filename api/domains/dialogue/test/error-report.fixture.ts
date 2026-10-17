import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { jstIso } from "../../../infrastructure/jst-time";
import { openStore } from "../../../infrastructure/sqlite";
import type { TaskDto } from "../../agent-runtime";
import {
	migration as conversationMigration,
	avatarMotionMigration as conversationAvatarMotionMigration,
	answerDeliveryMigration as conversationAnswerDeliveryMigration,
	createConversationService,
} from "../../conversation";
import type { LarmPort } from "../../larm";
import { createQueue, migration as queueMigration } from "../../queue";
import {
	agentLinkMigration,
	createDialogueService,
	migration,
	queueLinkMigration,
	registerDialogue,
} from "..";

export const T0 = Date.parse("2026-10-17T12:18:54.000Z");
export const BOOT = "beeb7ec6-2ef0-48b1-a9c0-bc6a16557bb6";
export const TASK = "be29f86c-d931-4712-be8f-8b1fa5da5dd6";
export const ROOT = "aa29f86c-d931-4712-be8f-8b1fa5da5dd6";
export const STEP = "84f305ff-28b0-4e6d-8578-44433495fb74";
export const STEP2 = "1c4eb0a9-1416-4811-9e60-4b224a6888f1";
export const AGENT_JOB = "fa5d6b14-d4fe-4ee2-9949-3989c4506091";
export const OTHER_RUN = "99999999-9999-4999-8999-999999999999";
const larm: LarmPort = {
	status: () => ({ state: "ready", capabilities: ["llm"] }),
	connect: async () => {},
	answer: async () => "回答",
	transcribe: async () => "",
	speak: async () => new Uint8Array(),
	close: async () => {},
};
const dirs: string[] = [];
/** Removes the directories the scenarios made; each test file runs it after every test. */
export function cleanup() {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
}

export type Ids = { run: string; request: string; job: string };
export type Fields = Record<string, unknown>;
export const entry =
	(level: string, offsetMs: number, component: string, event: string) =>
	(fields: Fields = {}) =>
		JSON.stringify({
			level,
			time: jstIso(T0 + offsetMs),
			service: "eumenes",
			pid: 1,
			bootId: BOOT,
			schemaVersion: 1,
			...fields,
			component,
			event,
		});

export function task(
	partial: Partial<TaskDto> & Pick<TaskDto, "id" | "kind">,
): TaskDto {
	return {
		rootRunId: "",
		parentTaskId: partial.kind === "worker" ? ROOT : null,
		packageRevisionId: null,
		status: "completed",
		phase: "completed",
		modelCalls: 0,
		toolCalls: 0,
		errorCode: null,
		createdAt: "2026-10-17T12:19:00.000Z",
		deadlineAt: "2026-10-17T12:25:00.000Z",
		reportState: "none",
		...partial,
	};
}

export async function scenario(options: {
	status?: "failed" | "completed" | "queued";
	error?: string | null;
	tasks?: TaskDto[];
	lines?: (ids: Ids) => string[];
	rotated?: (ids: Ids) => string[];
	noLog?: boolean;
}) {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-error-report-"));
	dirs.push(dir);
	const store = openStore(join(dir, "db.sqlite3"), [
		conversationMigration,
		conversationAvatarMotionMigration,
		conversationAnswerDeliveryMigration,
		migration,
		queueMigration,
		queueLinkMigration,
		agentLinkMigration,
	]);
	const queue = createQueue(store);
	const tasks = options.tasks ?? [];
	const logFile = join(dir, "api.jsonl");
	const dialogue = createDialogueService({
		store,
		conversation: createConversationService(store),
		larm,
		queue,
		agents: { list: () => tasks } as never,
		logFile: () => (options.noLog ? undefined : logFile),
	});
	const submitted = await dialogue.submit({
		requestId: crypto.randomUUID(),
		conversationId: "main",
		text: "ひみつの依頼文",
	});
	await store.write((db) => {
		db.query(
			"UPDATE dialogue_runs SET status=?, error=?, agent_task_id=?, updated_at=? WHERE id=?",
		).run(
			options.status ?? "failed",
			options.error ?? null,
			tasks.length ? ROOT : null,
			new Date(T0 + 30_000).toISOString(),
			submitted.id,
		);
	});
	const run = dialogue.get(submitted.id)!;
	const ids: Ids = {
		run: run.id,
		request: run.requestId,
		job: run.jobId ?? "",
	};
	if (options.lines)
		writeFileSync(logFile, `${options.lines(ids).join("\n")}\n`);
	if (options.rotated)
		writeFileSync(`${logFile}.1`, `${options.rotated(ids).join("\n")}\n`);
	const app = new Hono();
	registerDialogue(app, dialogue);
	return {
		ids,
		app,
		dialogue,
		report: async () => {
			const result = await dialogue.errorReport(run.id);
			return result.ok ? result.text : result;
		},
		close: async () => {
			await queue.close(100);
			await store.close();
		},
	};
}

/** The same record as written before the log time was JST: its `time` in UTC (`Z`). */
export const asUtc = (line: string) => {
	const record = JSON.parse(line) as { time: string };
	return JSON.stringify({
		...record,
		time: new Date(record.time).toISOString(),
	});
};

/** The lines of a run whose worker's control output broke the contract twice (the shape of a real run). */
export const controlFailure = ({ run, request, job }: Ids) => {
	const base = { runId: run, requestId: request };
	return [
		entry(
			"info",
			0,
			"dialogue",
			"dialogue.accepted",
		)({ ...base, jobId: job, status: "queued" }),
		entry(
			"info",
			6000,
			"dialogue",
			"dialogue.request_analyzed",
		)({
			...base,
			jobId: job,
			kind: "live_info",
			freshness: "live",
			next: "toolchain",
			durationMs: 5900,
		}),
		entry(
			"info",
			6100,
			"dialogue",
			"dialogue.candidates_selected",
		)({
			...base,
			jobId: job,
			candidateCount: 4,
			retrieval: "embedding",
			durationMs: 96,
		}),
		entry(
			"info",
			6200,
			"inference",
			"inference.attempt_succeeded",
		)({ ...base, jobId: job, purpose: "llm", durationMs: 5000 }),
		entry(
			"info",
			12000,
			"toolchain-history",
			"toolchain.selection_recorded",
		)({
			...base,
			jobId: job,
			decision: "toolchain",
			toolchainId: "web.search",
			candidateCount: 4,
		}),
		entry(
			"info",
			12100,
			"agent-runtime",
			"agent.state_changed",
		)({ ...base, jobId: job, taskId: TASK, status: "running", kind: "worker" }),
		entry(
			"info",
			18000,
			"agent-runtime",
			"agent.state_changed",
		)({
			...base,
			jobId: AGENT_JOB,
			taskId: TASK,
			status: "waiting_tool",
			kind: "worker",
		}),
		entry(
			"warn",
			33000,
			"agent-runtime",
			"agent.control_rejected",
		)({
			...base,
			jobId: AGENT_JOB,
			taskId: TASK,
			stepId: STEP,
			kind: "worker",
			phase: "search",
			repairAttempt: 0,
			status: "repair_scheduled",
			controlSchema: "worker",
			outputType: "string",
			bytes: 202,
			controlAction: "invoke",
			reason: "control_schema_invalid",
			issueCount: 1,
		}),
		entry(
			"warn",
			33000,
			"agent-runtime",
			"agent.control_validation_issue",
		)({
			...base,
			jobId: AGENT_JOB,
			taskId: TASK,
			stepId: STEP,
			kind: "worker",
			phase: "search",
			repairAttempt: 0,
			status: "repair_scheduled",
			controlAction: "invoke",
			reason: "control_schema_invalid",
			validationPath: "unknown.0",
			validationCode: "invalid_type",
			actualType: "string",
			expectedType: "object",
		}),
		entry(
			"warn",
			40000,
			"agent-runtime",
			"agent.control_rejected",
		)({
			...base,
			jobId: AGENT_JOB,
			taskId: TASK,
			stepId: STEP2,
			kind: "worker",
			phase: "search",
			repairAttempt: 1,
			status: "failed",
			controlSchema: "worker",
			controlAction: "invoke",
			reason: "control_schema_invalid",
			issueCount: 1,
		}),
		entry(
			"warn",
			40000,
			"agent-runtime",
			"agent.control_validation_issue",
		)({
			...base,
			jobId: AGENT_JOB,
			taskId: TASK,
			stepId: STEP2,
			kind: "worker",
			phase: "search",
			repairAttempt: 1,
			status: "failed",
			controlAction: "invoke",
			reason: "control_schema_invalid",
			validationPath: "unknown.0",
			validationCode: "invalid_type",
			actualType: "string",
			expectedType: "object",
		}),
		entry(
			"info",
			40100,
			"agent-runtime",
			"agent.state_changed",
		)({
			...base,
			jobId: AGENT_JOB,
			taskId: TASK,
			status: "failed",
			kind: "worker",
			reason: "invalid_control_json",
		}),
		entry(
			"info",
			41000,
			"queue",
			"queue.settled",
		)({ jobId: AGENT_JOB, attempt: 1, status: "completed", durationMs: 28000 }),
	];
};
