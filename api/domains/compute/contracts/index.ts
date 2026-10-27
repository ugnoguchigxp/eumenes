import { z } from "zod";
import type { HttpErrorStatus } from "../../../infrastructure/http";
export const submitInput = z
	.strictObject({
		code: z.string().min(1).max(65536),
		inputs: z.record(z.string(), z.json()).default({}),
		timeoutSec: z.number().int().min(1).max(60).default(60),
		accelerator: z.enum(["auto", "cpu"]).default("auto"),
	})
	.superRefine((v, ctx) => {
		if (
			Buffer.byteLength(v.code) > 65536 ||
			Buffer.byteLength(JSON.stringify(v.inputs)) > 262144
		)
			ctx.addIssue({ code: "custom", message: "limit_exceeded" });
	});
export type SubmitInput = z.infer<typeof submitInput>;
export type Artifact = {
	id: string;
	name: string;
	mime: "image/png" | "image/svg+xml" | "text/csv" | "application/json";
	bytes: number;
};
export type Result = {
	value: unknown;
	stdout: string;
	stderr: string;
	stdoutTruncated: boolean;
	stderrTruncated: boolean;
	artifacts: Artifact[];
};
export type RemoteJob = {
	jobId: string;
	status: "queued" | "running" | "completed" | "failed" | "cancelled";
	stage: string;
	queuedAt: string;
	startedAt: string | null;
	finishedAt: string | null;
	expiresAt: string | null;
	cancelRequested: boolean;
	progress?: { message: string; ratio?: number };
	result?: Result;
	error?: { code: string; message: string };
};
export type Environment = {
	protocol: "larm.compute.v1";
	python: string;
	packages: Array<{ name: string; version: string }>;
	accelerators: Array<{ kind: "cpu"; name: string; memoryMiB: number }>;
	limits: {
		maxTimeoutSec: number;
		maxCodeBytes: number;
		maxInputBytes: number;
		maxArtifactBytes: number;
		maxArtifacts: number;
		[key: string]: number;
	};
	environmentRevision: string;
};
/** External transport is injected by application; compute owns its state and SQL. */
export interface ComputePort {
	binding: string;
	discover(
		signal: AbortSignal,
	): Promise<{ url: string; description: string; environment: Environment }>;
	submit(
		url: string,
		body: SubmitInput,
		key: string,
		signal: AbortSignal,
	): Promise<string>;
	get(url: string, id: string, signal: AbortSignal): Promise<RemoteJob>;
	cancel(url: string, id: string, signal: AbortSignal): Promise<RemoteJob>;
	delete(
		url: string,
		id: string,
		signal: AbortSignal,
	): Promise<RemoteJob | null>;
	artifact(
		url: string,
		id: string,
		artifact: Artifact,
		signal: AbortSignal,
	): Promise<Uint8Array>;
}
export type JobState =
	| "submitting"
	| "queued"
	| "running"
	| "collecting"
	| "completed"
	| "failed"
	| "cancelled"
	| "indeterminate"
	| "deleted";
export type JobView = {
	id: string;
	state: JobState;
	stage: string | null;
	code: string;
	cancelRequested: boolean;
	progress: { message: string; ratio?: number } | null;
	result: Result | null;
	error: { code: string; message?: string } | null;
	artifactError: string | null;
	artifacts: Array<Artifact & { ready: boolean }>;
	expiresAt: string | null;
	createdAt: number;
	updatedAt: number;
	revision: number;
};
export const activeStates = ["submitting", "queued", "running", "collecting"];
/** HTTP status of each code the compute operations throw. */
export const errorStatus = {
	compute_not_found: 404,
	compute_artifact_not_found: 404,
	request_conflict: 409,
	compute_capacity: 429,
	invalid_request: 400,
	limit_exceeded: 400,
	compute_not_reconcilable: 409,
	compute_connection_changed: 409,
} as const satisfies Record<string, HttpErrorStatus>;
