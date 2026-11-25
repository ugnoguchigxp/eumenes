import type { Database } from "bun:sqlite";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import { imageRequest, type Capabilities } from "../../capabilities";
import type { InferencePort } from "../../inference";
import type { QueueService } from "../../queue";
import type { LarmPlayground } from "../../larm";
import type { ImageRecord } from "../contracts";
import {
	row,
	record,
	patch,
	list,
	activity,
	generatedVersion,
} from "../repository";
import { registerImageHandlers } from "./handlers";
import { createImageUpload } from "./imports";
import { generatedImageVersion } from "./version";
import type { ChildExecution } from "../../tool-runtime";
async function readContent(
	gateway: LarmPlayground,
	id: string,
	signal: AbortSignal,
) {
	const a = await gateway.images.get(id, signal);
	if (a.id !== id) throw new Error("image_version_unavailable");
	return gateway.artifact(
		{ id: a.id, path: a.contentUrl, mime: a.mimeType, actualModel: a.model },
		signal,
	);
}
/** Read-only source for the registered image screen; the image domain owns this query. */
export const imageListInTransaction = (db: Database, conversationId: string) =>
	list(db, conversationId);
const active = (r: ImageRecord) =>
	r.state === "planning" || r.state === "generating";
export function createImage(deps: {
	store: SqliteStore;
	queue: QueueService;
	inference: InferencePort;
	capabilities: Capabilities;
	gateway: () => LarmPlayground;
	validateExecutionInTransaction?: (
		db: Database,
		child: ChildExecution,
	) => boolean;
}) {
	const { store, queue, capabilities } = deps;
	function enqueue(
		db: Database,
		id: string,
		deadline: number,
		stage: "plan" | "generate",
		wait?: { at: number; count: number },
	) {
		const { job } = queue.enqueueInTransaction(db, {
			scope: "image",
			kind: `image.${stage}`,
			dedupeKey: wait ? `${id}:${stage}:w${wait.count}` : `${id}:${stage}`,
			...(wait ? { availableAtMs: wait.at } : {}),
			payload: { id },
			subjectRef: id,
			lane: "interactive",
			resourceKey: stage === "plan" ? "inference.llm" : "image.generate",
			maxAttempts: 1,
			deadlineAtMs: deadline - 15000,
		});
		db.query("UPDATE image_generations SET queue_job_id=? WHERE id=?").run(
			job.id,
			id,
		);
		return job.id;
	}
	function fail(db: Database, id: string, code: string) {
		const r = row(db, id);
		if (!r || !active(record(r))) return;
		patch(db, id, { state: "failed", errorCode: code, phase: "failed" });
	}
	function cancel(db: Database, job: { payload: { id: string } }) {
		const r = row(db, job.payload.id);
		if (!r || !active(record(r))) return;
		patch(db, r.id, {
			state: "cancelled",
			phase: "cancelled",
			errorCode: "cancel_requested",
		});
	}
	registerImageHandlers({ ...deps, enqueue, fail, cancel });
	return {
		imports: createImageUpload(deps),
		library: () => deps.gateway().images,
		content: (id: string, signal: AbortSignal) =>
			readContent(deps.gateway(), id, signal),
		generatedVersionInTransaction(
			db: Database,
			query: {
				runId: string;
				conversationId: string;
				artifactId: string;
			},
		) {
			return generatedVersion(
				db,
				query.runId,
				query.conversationId,
				query.artifactId,
			);
		},
		isGeneratedConnectionCurrent(version: string) {
			return version.startsWith(`${deps.gateway().mediaBinding}:`);
		},
		async generatedContent(id: string, version: string, signal: AbortSignal) {
			const gateway = deps.gateway();
			if (!version.startsWith(`${gateway.mediaBinding}:`))
				throw new Error("image_version_unavailable");
			const content = await readContent(gateway, id, signal);
			if (!content.bytes || content.bytes.length > 32 * 1024 * 1024)
				throw new Error("image_content_too_large");
			if (
				generatedImageVersion(deps.gateway().mediaBinding, content.bytes) !==
				version
			)
				throw new Error("image_version_unavailable");
			return content;
		},
		startInTransaction(
			db: Database,
			input: {
				runId: string;
				conversationId: string;
				question: string;
				originalRequest: string;
				deadline: number;
				execution: ChildExecution;
			},
		) {
			const id = input.execution.id;
			const existing = row(db, id);
			if (existing) return { id: existing.id, jobId: existing.queue_job_id! };
			const request = imageRequest.parse({ question: input.question });
			if (!deps.validateExecutionInTransaction?.(db, input.execution))
				throw new Error("execution_changed");
			const prepared = capabilities.prepareActiveByIdInTransaction(
				db,
				{ rootRunId: input.runId, taskId: id, cancelEpoch: 0 },
				"package:image.create@2",
				request,
			);
			const now = Date.now();
			const view: ImageRecord = {
				id,
				runId: input.runId,
				conversationId: input.conversationId,
				state: "planning",
				title: "画像",
				description: "",
				prompt: null,
				action: null,
				width: null,
				height: null,
				format: null,
				seed: null,
				artifactId: null,
				phase: "planning",
				errorCode: null,
				mime: null,
				actualModel: null,
				createdAt: now,
				updatedAt: now,
			};
			db.query(
				"INSERT INTO image_generations(id,run_id,conversation_id,record_json,request_json,bindings_json,deadline) VALUES(?,?,?,?,?,?,?)",
			).run(
				id,
				input.runId,
				input.conversationId,
				JSON.stringify(view),
				JSON.stringify({
					...request,
					originalRequest: input.originalRequest,
					execution: input.execution,
					references: input.execution.refs,
				}),
				JSON.stringify(prepared),
				input.deadline,
			);
			return {
				id,
				jobId: enqueue(db, id, input.deadline, "plan"),
			};
		},
		purgeCallInTransaction(db: Database, id: string) {
			db.query(
				"UPDATE image_generations SET request_json=json_object('execution',json_object('id',id,'erased',1)) WHERE id=? AND json_extract(request_json,'$.execution') IS NOT NULL",
			).run(id);
		},
		resultForCallInTransaction(db: Database, id: string) {
			const r = row(db, id);
			return r ? record(r) : null;
		},
		cancelCallInTransaction(db: Database, id: string) {
			const r = row(db, id);
			if (r?.queue_job_id && active(record(r))) {
				cancel(db, { payload: { id } });
				queue.cancelInTransaction(db, r.queue_job_id, "execution_cancelled");
			}
		},
		get: (id: string) =>
			store.read((db) => {
				const r = row(db, id);
				return r ? record(r) : null;
			}),
		list: (conversationId: string) =>
			store.read((db) => list(db, conversationId)),
		activity: (since: number) => store.read((db) => activity(db, since)),
	};
}
export type ImageService = ReturnType<typeof createImage>;
