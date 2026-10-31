import { createHash } from "node:crypto";
import { z } from "zod";
import { CONVERSATION_DEFAULT_PRINCIPAL } from "../../domains/conversation/contracts";
import type { ComputeService, JobView } from "../../domains/compute";
import type { AdapterResult, DomainAdapter } from "../../domains/tool-runtime";
import type { Database } from "bun:sqlite";

export const COMPUTE_ADAPTER_REF = "adapter:compute@1";
export const computeDomainSchemas = {
	"domain:compute.receipt@1": z.looseObject({
		action: z.string(),
		jobId: z.uuid(),
	}),
};
const operations = [
	["compute.submit", "builtin:computePythonSubmit", "write"],
	["compute.status", "builtin:computeJobTarget", "read"],
	["compute.cancel", "builtin:computeJobTarget", "write"],
	["compute.artifact", "builtin:computeArtifactTarget", "read"],
] as const;
export const describeComputeAdapter = () => ({
	owner: "compute",
	operations: new Map<
		string,
		{ inputSchemaRef: string; effect: "read" | "write" }
	>(
		operations.map(([name, inputSchemaRef, effect]) => [
			name,
			{ inputSchemaRef, effect },
		]),
	),
	queries: new Set(["query:compute.workspace@1"]),
	inputAdapters: new Map(),
	projections: new Set(["projection:compute-result@1"]),
	availability: "availability:compute@1",
});
function result(
	value: unknown,
	requestId: string,
	replay: boolean,
): AdapterResult {
	const text = JSON.stringify(value);
	const receipt = value as {
		action: string;
		jobId: string;
		job?: JobView;
	};
	const j = receipt.job;
	const projected = JSON.stringify({
		action: receipt.action,
		jobId: receipt.jobId,
		state: j?.state,
		value: j?.result?.value,
		error: j?.error,
		artifacts: j?.artifacts,
		artifactError: j?.artifactError,
		progress: j?.progress,
	});
	return {
		receipt: value,
		receiptRef: {
			owner: "compute",
			operationId: requestId,
			digest: createHash("sha256").update(text).digest("hex"),
		},
		resultRefs: [],
		replay,
		answerContext: {
			kind: "compute",
			result: projected.slice(0, 12000),
			truncated: projected.length > 12000,
		},
	};
}
/** Keep saved code and large outputs out of the next command's finite input budget. */
function commandSnapshot(service: ComputeService, db: Database, owner: string) {
	const current = service.snapshotInTransaction(db, owner);
	let remaining = 12000;
	const jobs = current.jobs
		.slice(0, 10)
		.map((j) => ({
			id: j.id,
			state: j.state,
			stage: j.stage,
			cancelRequested: j.cancelRequested,
			progress: j.progress
				? { ...j.progress, message: j.progress.message.slice(0, 256) }
				: null,
			error: j.error ? { code: j.error.code } : null,
			artifacts: j.artifacts,
			hasResult: j.result !== null,
			resultPreview: j.result
				? JSON.stringify(j.result.value).slice(0, 512)
				: null,
		}))
		.filter((j) => {
			remaining -= Buffer.byteLength(JSON.stringify(j));
			return remaining >= 0;
		});
	return { ...current, jobs };
}
export function createComputeAdapter(service: ComputeService): DomainAdapter {
	const owner = CONVERSATION_DEFAULT_PRINCIPAL;
	return {
		ref: COMPUTE_ADAPTER_REF,
		describe: describeComputeAdapter,
		availableInTransaction: (db) => service.availableInTransaction(db),
		artifactAvailableInTransaction: () => true,
		snapshotInTransaction: (db) => commandSnapshot(service, db, owner),
		invokeInTransaction(db, request) {
			const conversationId =
				request.origin.kind === "conversation" || request.origin.kind === "task"
					? request.origin.conversationId
					: "main";
			if (!describeComputeAdapter().operations.has(request.operationName))
				throw new Error("unsupported_operation");
			const schema =
				request.operationName === "compute.submit"
					? null
					: request.operationName === "compute.artifact"
						? z.strictObject({ jobId: z.uuid(), artifactId: z.uuid() })
						: z.strictObject({ jobId: z.uuid() });
			if (schema) {
				schema.parse(request.input);
				// The model snapshot is bounded context, not an authorization list.
				// The domain checks the exact job owner and conversation below.
			}
			const saved = service.commandInTransaction(
				db,
				owner,
				conversationId,
				request.origin.kind === "task"
					? "task"
					: request.origin.kind === "conversation"
						? "conversation"
						: "screen",
				`python_${request.operationName.slice("compute.".length)}`,
				request.input,
				request.requestId,
				request.origin.kind === "task"
					? request.origin.execution.deadline
					: undefined,
				request.origin.kind === "task" ? request.origin.execution : undefined,
			);
			return result(saved.value, request.requestId, saved.replay);
		},
		readInTransaction(db, id) {
			const value = service.readInTransaction(db, owner, id);
			return value ? result(value, id, true) : null;
		},
		sourceInTransaction(db, query, target) {
			if (query !== "query:compute.workspace@1" || target !== undefined)
				return null;
			const snapshot = service.snapshotInTransaction(db, owner);
			return {
				revision: snapshot.jobs.reduce((n, j) => n + j.revision, 0),
				data: snapshot,
			};
		},
		targetInput: () => ({}),
		execution: {
			stop: (id) => service.confirmStop(owner, id),
			currentInTransaction(db, id, child) {
				const current = service.currentInTransaction(db, owner, id);
				const receipt = service.readInTransaction(db, owner, id);
				const job = current?.job;
				const state = !job
					? "failed"
					: (current.invalidated || Date.now() >= child.deadline) &&
						  ![
								"completed",
								"failed",
								"cancelled",
								"deleted",
								"indeterminate",
						  ].includes(job.state)
						? "running"
						: current.invalidated || Date.now() >= child.deadline
							? "expired"
							: receipt?.action === "python_status"
								? "completed"
								: job.state === "indeterminate"
									? "indeterminate"
									: job.state === "failed" || job.state === "deleted"
										? "failed"
										: job.state === "cancelled"
											? "cancelled"
											: job.state === "completed"
												? "completed"
												: "running";
				const output = job
					? {
							jobId: job.id,
							state: job.state,
							value: job.result?.value,
							error: job.error,
							artifactError: job.artifactError,
							artifacts: job.artifacts,
							progress: job.progress,
						}
					: null;
				return {
					state,
					ref: { operationId: id },
					summary: JSON.stringify(output).slice(0, 2000),
					output,
					code: job?.error?.code,
					modelCalls: 0,
					references: [],
				};
			},
			cancelInTransaction(db, id) {
				const saved = service.readInTransaction(db, owner, id);
				if (saved) service.cancelInTransaction(db, owner, saved.jobId, true);
			},
			validateAnswerInTransaction: () => false,
		},
	};
}
