import { z } from "zod";
import { callJson, type Transport } from "./transport";
import type { JobView } from "../api/domains/compute/contracts";

export const computeJobView = z.object({
	id: z.uuid(),
	state: z.enum([
		"submitting",
		"queued",
		"running",
		"collecting",
		"completed",
		"failed",
		"cancelled",
		"indeterminate",
		"deleted",
	]),
	stage: z.string().nullable(),
	code: z.string(),
	cancelRequested: z.boolean(),
	progress: z
		.object({ message: z.string(), ratio: z.number().min(0).max(1).optional() })
		.nullable(),
	result: z
		.object({
			value: z.unknown(),
			stdout: z.string(),
			stderr: z.string(),
			stdoutTruncated: z.boolean(),
			stderrTruncated: z.boolean(),
			artifacts: z.array(
				z.object({
					id: z.uuid(),
					name: z.string(),
					mime: z.enum([
						"image/png",
						"image/svg+xml",
						"text/csv",
						"application/json",
					]),
					bytes: z.number(),
				}),
			),
		})
		.nullable(),
	error: z
		.object({ code: z.string(), message: z.string().optional() })
		.nullable(),
	artifactError: z.string().nullable(),
	artifacts: z.array(
		z.object({
			id: z.uuid(),
			name: z.string(),
			mime: z.enum([
				"image/png",
				"image/svg+xml",
				"text/csv",
				"application/json",
			]),
			bytes: z.number(),
			ready: z.boolean(),
		}),
	),
	expiresAt: z.string().nullable(),
	createdAt: z.number(),
	updatedAt: z.number(),
	revision: z.number(),
}) satisfies z.ZodType<JobView>;
export function computeClient(t: Transport) {
	const path = (id: string) => `/api/compute/jobs/${z.uuid().parse(id)}`;
	return {
		compute: {
			jobs: async (signal?: AbortSignal) =>
				(
					await callJson(
						t,
						z.object({ jobs: z.array(computeJobView) }),
						"/api/compute/jobs",
						{ signal },
					)
				).jobs,
			cancel: (id: string) =>
				callJson(t, computeJobView, `${path(id)}/cancel`, { method: "POST" }),
			reconcile: (id: string) =>
				callJson(t, computeJobView, `${path(id)}/reconcile`, {
					method: "POST",
				}),
			artifact: async (
				id: string,
				artifactId: string,
				signal?: AbortSignal,
			) => {
				const r = await t.call(
					`${path(id)}/artifacts/${z.uuid().parse(artifactId)}`,
					{ signal },
				);
				const content = await r.blob();
				if (content.size > 5 * 1024 * 1024)
					throw new Error("compute_artifact_too_large");
				return content;
			},
		},
	};
}
