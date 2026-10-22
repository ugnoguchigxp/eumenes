import { z } from "zod";
import { callJson, type Transport } from "./transport";

/** A finding of the pipeline check: where (a JSON Pointer) and which rule, never the value. */
const issue = z.object({ pointer: z.string(), rule: z.string() });
const refused = z.object({ ok: z.literal(false), issues: z.array(issue) });
const unavailable = z.object({ ok: z.literal(false), code: z.string() });

/** Where the draft and the other toolchains rank for one wording (spec task-pipeline-design §8.2 検索の確認). */
export const pipelineProbe = z.union([
	z.object({
		ok: z.literal(true),
		candidates: z.array(
			z.object({
				toolchainId: z.string(),
				title: z.string(),
				functionName: z.string(),
				rank: z.number().int(),
				similarity: z.number().nullable(),
				ftsRank: z.number().nullable(),
				draft: z.boolean(),
			}),
		),
		/** The draft's own passages (what the index embeds) and how close each is to the wording. */
		passages: z.array(z.object({ text: z.string(), similarity: z.number() })),
	}),
	refused,
	unavailable,
]);
/** What the first round chose for one utterance, without running anything (選択の試験). */
export const pipelineSelection = z.union([
	z.object({
		ok: z.literal(true),
		/** The function the round called, or null when it called none. */
		chosen: z.string().nullable(),
		/** The round chose this draft. */
		matched: z.boolean(),
		next: z.string().nullable(),
		inputs: z.record(z.string(), z.unknown()).nullable(),
		/** Why the call was refused (a structural code), when it was. */
		code: z.string().nullable(),
	}),
	refused,
	unavailable,
]);
/** One fixture case run without toolchains (試験運転). */
export const pipelineFixture = z.union([
	z.object({
		ok: z.literal(true),
		outcome: z.object({
			passed: z.boolean(),
			steps: z.array(
				z.object({
					id: z.string(),
					request: z.string().optional(),
					arguments: z.unknown().optional(),
					fault: z.string().optional(),
				}),
			),
			answer: z.string().optional(),
			failures: z.array(
				z.object({
					path: z.string(),
					code: z.string(),
					expected: z.unknown().optional(),
					actual: z.unknown().optional(),
				}),
			),
		}),
	}),
	refused,
]);
export type PipelineProbe = z.infer<typeof pipelineProbe>;
export type PipelineSelection = z.infer<typeof pipelineSelection>;
export type PipelineFixture = z.infer<typeof pipelineFixture>;

/** The studio's trials of its current draft; the draft is read by the server from the work, never sent. */
export function pipelinesClient(t: Transport) {
	const path = (workRef: string, action: string) =>
		`/api/pipelines/works/${encodeURIComponent(workRef)}/${action}`;
	const post = (body: unknown, signal?: AbortSignal) => ({
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
		signal,
	});
	return {
		pipelines: {
			probe: (workRef: string, query: string, signal?: AbortSignal) =>
				callJson(
					t,
					pipelineProbe,
					path(workRef, "probe"),
					post({ query }, signal),
				),
			select: (workRef: string, utterance: string, signal?: AbortSignal) =>
				callJson(
					t,
					pipelineSelection,
					path(workRef, "select"),
					post({ utterance }, signal),
				),
			fixture: (workRef: string, test: number, signal?: AbortSignal) =>
				callJson(
					t,
					pipelineFixture,
					path(workRef, "fixture"),
					post({ test }, signal),
				),
		},
	};
}
