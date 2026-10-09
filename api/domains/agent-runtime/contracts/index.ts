import { z } from "zod";
import type { SourceMetadata } from "../../tool-runtime";
export const reportSchema = z
	.object({
		summary: z.string().min(1).max(2000),
		claims: z
			.array(
				z
					.object({
						text: z.string().min(1).max(500),
						evidence: z
							.array(
								z
									.object({
										sourceId: z.string(),
										quote: z.string().min(1).max(400),
									})
									.strict(),
							)
							.min(1)
							.max(3),
					})
					.strict(),
			)
			.min(1)
			.max(8),
		limitations: z.array(z.string().max(300)).max(8),
	})
	.strict();
export type Report = z.infer<typeof reportSchema> & {
	sources: SourceMetadata[];
	coverage: "complete" | "partial";
	verification: "evidence_linked";
};
export const routeSchema = z.discriminatedUnion("action", [
	z.object({ action: z.literal("respond") }).strict(),
	z
		.object({
			action: z.literal("clarify"),
			question: z.string().min(1).max(300),
		})
		.strict(),
	z
		.object({
			action: z.literal("discover"),
			intent: z.string().max(400),
			terms: z.array(z.string().min(1).max(80)).min(1).max(8),
		})
		.strict(),
]);
export const selectSchema = z.discriminatedUnion("action", [
	z
		.object({
			action: z.literal("select"),
			candidateRef: z.string().uuid(),
			input: z.unknown(),
		})
		.strict(),
	z
		.object({
			action: z.literal("refine"),
			intent: z.string().max(400),
			terms: z.array(z.string().min(1).max(80)).min(1).max(8),
		})
		.strict(),
	z
		.object({
			action: z.literal("clarify"),
			question: z.string().min(1).max(300),
		})
		.strict(),
	z.object({ action: z.literal("unavailable") }).strict(),
]);
export const workerSchema = z.discriminatedUnion("action", [
	z
		.object({
			action: z.literal("invoke"),
			executionRef: z.string().uuid(),
			arguments: z.unknown(),
		})
		.strict(),
	z.object({ action: z.literal("finish"), report: reportSchema }).strict(),
]);
export type Task = {
	id: string;
	kind: "coordinator" | "worker";
	root_run_id: string;
	parent_task_id: string | null;
	package_revision_id: string | null;
	input_json: string | null;
	state: string;
	phase: string;
	revision: number;
	cancel_epoch: number;
	data_epoch: number;
	report_state: string;
	report_task_id: string | null;
	current_step: number;
	deadline: number;
	model_calls: number;
	tool_calls: number;
	json_repairs: number;
	refinements: number;
	job_id: string | null;
	invocation_id: string | null;
	error_code: string | null;
	created_at: number;
	updated_at: number;
};
export type TaskDto = {
	id: string;
	kind: Task["kind"];
	rootRunId: string;
	parentTaskId: string | null;
	packageRevisionId: string | null;
	status: string;
	phase: string;
	modelCalls: number;
	toolCalls: number;
	errorCode: string | null;
	createdAt: string;
	deadlineAt: string;
	reportState: string;
};
export const taskDtoSchema = z.object({
	id: z.string(),
	kind: z.enum(["coordinator", "worker"]),
	rootRunId: z.string(),
	parentTaskId: z.string().nullable(),
	packageRevisionId: z.string().nullable(),
	status: z.string(),
	phase: z.string(),
	modelCalls: z.number(),
	toolCalls: z.number(),
	errorCode: z.string().nullable(),
	createdAt: z.string(),
	deadlineAt: z.string(),
	reportState: z.string(),
	toolOutcomes: z
		.array(
			z.object({
				toolRevisionId: z.string(),
				state: z.string(),
				errorCode: z.string().nullable(),
				sourceCount: z.number(),
			}),
		)
		.optional(),
});
export type AnswerTicket = {
	taskId: string;
	eventId: string;
	revision: number;
	dataEpoch: number;
	reportTaskId: string | null;
	reportEpoch: number | null;
	reportDigest: string | null;
	projection: string | null;
	failureCode: string | null;
};
