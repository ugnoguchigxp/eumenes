import { z } from "zod";

export const computeRequest = z.strictObject({
	code: z.string().min(1),
	inputs: z.record(z.string(), z.json()).default({}),
	timeoutSec: z.number().int().min(1).max(60).default(60),
	accelerator: z.enum(["auto", "cpu"]).default("auto"),
});
export const computeArtifact = z.strictObject({
	id: z.uuid(),
	name: z.string().min(1).max(128),
	mime: z.enum(["image/png", "image/svg+xml", "text/csv", "application/json"]),
	bytes: z
		.number()
		.int()
		.min(0)
		.max(5 * 1024 * 1024),
});
export const computeRemoteJob = z.strictObject({
	jobId: z.uuid(),
	status: z.enum(["queued", "running", "completed", "failed", "cancelled"]),
	stage: z.enum([
		"queued",
		"starting",
		"running",
		"collecting",
		"completed",
		"failed",
		"cancelled",
	]),
	queuedAt: z.string(),
	startedAt: z.string().nullable(),
	finishedAt: z.string().nullable(),
	expiresAt: z.string().nullable(),
	resolvedAccelerator: z.literal("cpu"),
	environmentRevision: z.string().max(256),
	cancelRequested: z.boolean(),
	progress: z
		.strictObject({
			message: z.string().max(1024),
			ratio: z.number().min(0).max(1).optional(),
		})
		.optional(),
	result: z
		.strictObject({
			value: z.json(),
			stdout: z.string().max(262144),
			stderr: z.string().max(262144),
			stdoutTruncated: z.boolean(),
			stderrTruncated: z.boolean(),
			artifacts: z.array(computeArtifact).max(10),
		})
		.optional(),
	error: z
		.strictObject({
			code: z.enum([
				"timeout",
				"memory_exceeded",
				"runtime_error",
				"syntax_error",
				"limit_exceeded",
				"output_exceeded",
				"unavailable",
				"cancelled",
				"queue_timeout",
			]),
			message: z.string().max(8192),
		})
		.optional(),
});
export const computeEnvironment = z.object({
	protocol: z.literal("larm.compute.v1"),
	python: z.string().max(128),
	packages: z
		.array(
			z.strictObject({
				name: z.string().max(128),
				version: z.string().max(128),
			}),
		)
		.max(100),
	accelerators: z
		.array(
			z.strictObject({
				kind: z.literal("cpu"),
				name: z.string().max(256),
				memoryMiB: z.number().nonnegative(),
			}),
		)
		.max(16),
	limits: z
		.object({
			maxTimeoutSec: z.number().int().positive(),
			maxCodeBytes: z.number().int().positive(),
			maxInputBytes: z.number().int().positive(),
			maxArtifacts: z.number().int().nonnegative(),
			maxArtifactBytes: z.number().int().nonnegative(),
		})
		.catchall(z.number().nonnegative()),
	environmentRevision: z.string().max(256),
	sandbox: z.object({
		network: z.literal(false),
		gpu: z.literal(false),
		subprocesses: z.literal(false),
		userThreads: z.literal(false),
		memoryAccounting: z.literal("address_space"),
	}),
});
