import type { Database } from "bun:sqlite";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import type { LarmPlayground, TestOutput } from "../../larm";
import type { QueueService } from "../../queue";
import { MEDIA_GENERATION_TIMEOUT_MS, imagePlanV2 } from "../../capabilities";
import {
	prototypeImageRequest,
	prototypeImageView,
	type PrototypeImageRequest,
} from "../contracts";
import {
	patch,
	prototypeGeneration,
	record,
	type Row,
	type StoredImage,
} from "../repository";
import { generatedImageVersion } from "./version";

export type PrototypeImageGuard = (
	db: Database,
	project: string,
	revision: number,
) => boolean;
const totalTimeout = 35 * 60_000;
const view = (r: Row) => {
	const result = record(r);
	return prototypeImageView.parse({
		operationId: r.operation_id,
		state: result.state,
		phase: result.phase,
		errorCode: result.errorCode,
		deadline: r.hard_deadline,
	});
};
export function prototypeImages(deps: {
	store: SqliteStore;
	queue: QueueService;
	gateway(): LarmPlayground;
	prototypeGuard?: PrototypeImageGuard;
	readContent(
		gateway: LarmPlayground,
		id: string,
		signal: AbortSignal,
	): Promise<TestOutput>;
	enqueue(
		db: Database,
		id: string,
		deadline: number,
		stage: "generate",
	): string;
	cancel(db: Database, job: { payload: { id: string } }): void;
}) {
	const { store, queue } = deps;
	function verify(db: Database, project: string, revision: number) {
		if (!deps.prototypeGuard?.(db, project, revision))
			throw new Error("prototype_grant_revoked");
	}
	function owned(db: Database, project: string, operation: string) {
		const r = prototypeGeneration(db, project, operation);
		if (!r) throw new Error("prototype_image_not_found");
		verify(db, project, r.grant_revision!);
		return r;
	}
	function cancelRow(db: Database, r: Row) {
		if (!r.queue_job_id || record(r).state !== "generating") return null;
		deps.cancel(db, { payload: { id: r.id } });
		queue.cancelInTransaction(db, r.queue_job_id, "execution_cancelled");
		patch(db, r.id, { artifactId: null, actualModel: null, mime: null });
		return r.queue_job_id;
	}
	return {
		startInTransaction(
			db: Database,
			project: string,
			revision: number,
			raw: PrototypeImageRequest,
			inputVersion: () => string,
		) {
			verify(db, project, revision);
			const input = prototypeImageRequest.parse(raw);
			const prior = prototypeGeneration(db, project, input.operationId);
			const canonical = JSON.stringify(input);
			if (prior) {
				if (
					prior.grant_revision !== revision ||
					prior.request_json !== canonical
				)
					throw new Error("prototype_operation_conflict");
				return view(prior);
			}
			const now = Date.now();
			const hard = Math.min(now + totalTimeout, input.deadline ?? Infinity);
			const deadline = Math.min(hard, now + MEDIA_GENERATION_TIMEOUT_MS);
			if (deadline <= now + 15_000) throw new Error("prototype_image_deadline");
			const { prompt, width, height, format, seed } = input;
			const plan = imagePlanV2.parse({
				prompt,
				width,
				height,
				format,
				seed,
				action: "generate",
				title: "Works画像",
				description: "",
			});
			const id = crypto.randomUUID();
			const result: StoredImage = {
				...plan,
				id,
				runId: null,
				conversationId: null,
				state: "generating",
				phase: "queued",
				artifactId: null,
				actualModel: null,
				mime: null,
				errorCode: null,
				createdAt: now,
				updatedAt: now,
			};
			db.query(
				`INSERT INTO image_generations (id, origin, prototype_id, operation_id, grant_revision, hard_deadline,
				deadline, record_json, request_json, plan_json, bindings_json)
				VALUES (?, 'prototype', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			).run(
				id,
				project,
				input.operationId,
				revision,
				hard,
				deadline,
				JSON.stringify(result),
				canonical,
				JSON.stringify(plan),
				JSON.stringify({ inputVersion: inputVersion() }),
			);
			deps.enqueue(db, id, deadline, "generate");
			return view(prototypeGeneration(db, project, input.operationId)!);
		},
		list(project: string, revision: number) {
			return store.read((db) => {
				verify(db, project, revision);
				return db
					.query<Row, [string, number]>(
						`SELECT * FROM image_generations WHERE origin='prototype'
					AND prototype_id=? AND grant_revision=? ORDER BY rowid DESC LIMIT 20`,
					)
					.all(project, revision)
					.map(view);
			});
		},
		status(project: string, operation: string) {
			return store.read((db) => view(owned(db, project, operation)));
		},
		async cancel(project: string, operation: string) {
			const [result, job] = await store.write((db) => {
				const r = owned(db, project, operation);
				const job = cancelRow(db, r);
				return [view(owned(db, project, operation)), job] as const;
			});
			if (job) queue.flushCancellations([job]);
			return result;
		},
		revokeInTransaction(db: Database, project: string) {
			const rows = db
				.query<Row, [string]>(
					`SELECT * FROM image_generations WHERE origin='prototype'
				AND prototype_id=? AND json_extract(record_json,'$.state')='generating'`,
				)
				.all(project);
			return rows.flatMap((r) => {
				const job = cancelRow(db, r);
				return job ? [job] : [];
			});
		},
		async content(project: string, operation: string, signal: AbortSignal) {
			const accepted = store.read((db) => owned(db, project, operation));
			const item = record(accepted);
			if (
				item.state !== "completed" ||
				!item.artifactId ||
				!accepted.generated_version
			)
				throw new Error("prototype_image_not_found");
			const gateway = deps.gateway();
			const content = await deps.readContent(gateway, item.artifactId, signal);
			if (
				!content.bytes?.length ||
				content.bytes.length > 16 * 1024 * 1024 ||
				!content.mime?.startsWith("image/") ||
				generatedImageVersion(deps.gateway().mediaBinding, content.bytes) !==
					accepted.generated_version
			)
				throw new Error("prototype_image_content_unavailable");
			store.read((db) => owned(db, project, operation));
			return content;
		},
		publish() {
			queue.wake();
		},
		flush(ids: string[]) {
			queue.flushCancellations(ids);
		},
	};
}
