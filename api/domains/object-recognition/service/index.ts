import { recognitionCommand } from "../../capabilities/contracts";
import type { Database } from "bun:sqlite";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import type { QueueService } from "../../queue";
import {
	maxInputBytes,
	inputMime,
	handoffLifetimeMs,
	type Connection,
	type RecognitionRecord,
} from "../contracts";
import {
	binding,
	insertHandoff,
	list,
	owned,
	patch,
	record,
	row,
} from "../repository";
import { registerRecognitionHandlers } from "./handlers";
import { bindCapture, createHandoffs } from "./handoff";
const workspaceArtifact = "artifact:object-recognition.workspace@";
export function createObjectRecognition(deps: {
	store: SqliteStore;
	queue: QueueService;
	connection: () => Connection | null;
	fetcher?: typeof fetch;
}) {
	const { store, queue } = deps;
	function cancelInTransaction(db: Database, owner: string, id: string) {
		const r = owned(db, id, owner);
		const v = record(r);
		if (["completed", "cancelled", "failed", "cancelling"].includes(v.state))
			return v;
		if (v.state === "queued" && !r.upstream_id)
			return patch(db, id, { state: "cancelled", result: null });
		const updated = patch(db, id, { state: "cancelling", result: null });
		if (r.upstream_id) enqueue(db, id, "cancel");
		return updated;
	}
	function enqueue(
		db: Database,
		id: string,
		stage: "analyze" | "poll" | "cancel",
		delay = 0,
	) {
		const r = row(db, id)!;
		const step = r.step + 1;
		db.query("UPDATE object_recognition_inputs SET step=? WHERE id=?").run(
			step,
			id,
		);
		return queue.enqueueInTransaction(db, {
			scope: "object-recognition",
			kind: `object-recognition.${stage}`,
			dedupeKey: `${id}:${step}`,
			payload: { id, step },
			subjectRef: id,
			lane: "interactive",
			resourceKey: "object-recognition",
			concurrencyKey: `recognition:${id}`,
			availableAtMs: Date.now() + delay,
			deadlineAtMs: r.deadline,
			maxAttempts: stage === "poll" ? 3 : 1,
		}).job.id;
	}
	registerRecognitionHandlers({ ...deps, enqueue });
	return {
		async upload(
			owner: string,
			conversationId: string,
			file: File,
			requestId: string,
			origin: NonNullable<RecognitionRecord["origin"]> = "file",
			/** The capture request this still answers; bound here so a reload never takes a second one. */
			handoffId?: string,
		) {
			const mime = inputMime.safeParse(file.type);
			if (!mime.success) throw new Error("invalid_recognition_format");
			if (!file.size || file.size > maxInputBytes)
				throw new Error("payload_too_large");
			const connection = deps.connection();
			if (!connection) throw new Error("recognition_not_configured");
			const bytes = new Uint8Array(await file.arrayBuffer());
			return store.write((db) => {
				if (handoffId)
					bindCapture(db, owner, handoffId, conversationId, requestId);
				const existing = row(db, requestId);
				if (existing) {
					owned(db, requestId, owner);
					if (
						existing.conversation_id !== conversationId ||
						existing.mime !== mime.data ||
						!Buffer.from(existing.bytes).equals(bytes)
					)
						throw new Error("request_conflict");
					return record(existing);
				}
				const active = list(db, owner, conversationId).filter((r) =>
					["queued", "starting", "running", "cancelling"].includes(r.state),
				);
				if (active.length >= 3) throw new Error("recognition_capacity");
				const now = Date.now();
				const v: RecognitionRecord = {
					id: requestId,
					conversationId,
					name: file.name.slice(0, 200),
					mime: mime.data,
					state: "queued",
					revision: 0,
					progress: null,
					errorCode: null,
					result: null,
					createdAt: now,
					updatedAt: now,
					origin,
				};
				db.query(
					"INSERT INTO object_recognition_inputs(id,owner,conversation_id,mime,bytes,record_json,connection_json,deadline) VALUES(?,?,?,?,?,?,?,?)",
				).run(
					requestId,
					owner,
					conversationId,
					mime.data,
					bytes,
					JSON.stringify(v),
					binding(connection),
					now + 600_000,
				);
				enqueue(db, requestId, "analyze");
				return v;
			});
		},
		get: (owner: string, id: string) =>
			store.read((db) => record(owned(db, id, owner))),
		list: (owner: string, conversationId: string) =>
			store.read((db) => list(db, owner, conversationId)),
		content: (owner: string, id: string) =>
			store.read((db) => {
				const r = owned(db, id, owner);
				return { bytes: r.bytes, mime: r.mime };
			}),
		cancel: (owner: string, id: string) =>
			store.write((db) => cancelInTransaction(db, owner, id)),
		commands: (owner: string, conversationId: string) =>
			store.read((db) =>
				(
					db
						.query(
							"SELECT run_id FROM object_recognition_commands WHERE owner=? AND conversation_id=? ORDER BY rowid DESC LIMIT 100",
						)
						.all(owner, conversationId) as { run_id: string }[]
				).map((r) => r.run_id),
			),
		port(owner: string) {
			return {
				/** `shown` marks the owned record the run's screen showed (host-checked, never a grant by itself). */
				snapshotInTransaction: (
					db: Database,
					conversationId: string,
					viewing?: { artifactRevisionId: string; targetRef: string } | null,
				) => {
					const shown = viewing?.artifactRevisionId.startsWith(
						workspaceArtifact,
					)
						? viewing.targetRef
						: null;
					return list(db, owner, conversationId).map((v) => ({
						id: v.id,
						name: v.name,
						kind: v.mime.startsWith("image/") ? "image" : "video",
						state: v.state,
						frameTimes:
							v.result?.kind === "video"
								? v.result.frames.map((f) => f.timestampSeconds)
								: [],
						...(v.id === shown ? { shown: true } : {}),
					}));
				},
				invokeInTransaction(
					db: Database,
					runId: string,
					conversationId: string,
					raw: unknown,
					input?: { inputImages: number; callId?: string },
				) {
					const command = recognitionCommand.parse(raw);
					const operationId = input?.callId ?? runId;
					if (
						input?.callId &&
						db
							.query(
								"SELECT 1 FROM object_recognition_execution_commands WHERE call_id=? AND run_id=? AND owner=?",
							)
							.get(input.callId, runId, owner)
					)
						return;
					let result: unknown = { action: "open", state: "ready_for_input" };
					if (
						(command.action === "capture" || command.action === "ask") &&
						(input?.inputImages ?? 0) > 0
					)
						// The message already carries the image (e.g. a sent capture): show it, don't take another.
						result = { action: command.action, state: "already_attached" };
					else if (command.action === "capture") {
						const source = command.source ?? "camera";
						insertHandoff(db, owner, {
							id: operationId,
							conversationId,
							source,
							recognitionId: null,
							question: command.question ?? "",
							deadline: Date.now() + handoffLifetimeMs,
						});
						result = { action: "capture", state: "awaiting_capture", source };
					} else if (command.action === "ask") {
						const r = owned(db, command.id, owner);
						if (r.conversation_id !== conversationId)
							throw new Error("recognition_not_found");
						if (!r.mime.startsWith("image/"))
							throw new Error("recognition_image_required");
						insertHandoff(db, owner, {
							id: operationId,
							conversationId,
							source: "saved",
							recognitionId: r.id,
							question: command.question ?? "",
							deadline: Date.now() + handoffLifetimeMs,
						});
						result = {
							action: "ask",
							state: "sending",
							id: r.id,
							name: record(r).name,
						};
					} else if (command.action !== "open") {
						const r = owned(db, command.id, owner);
						if (r.conversation_id !== conversationId)
							throw new Error("recognition_not_found");
						const v =
							command.action === "cancel"
								? cancelInTransaction(db, owner, command.id)
								: record(r);
						result = {
							action: command.action,
							...v,
							result:
								v.result?.kind === "video" && command.frameIndex >= 0
									? {
											...v.result,
											frames: v.result.frames.filter(
												(_, i) => i === command.frameIndex,
											),
										}
									: v.result,
						};
					}
					if (input?.callId)
						db.query(
							"INSERT INTO object_recognition_execution_commands VALUES(?,?,?,?,?)",
						).run(
							input.callId,
							runId,
							owner,
							conversationId,
							JSON.stringify(result),
						);
					else
						db.query(
							"INSERT INTO object_recognition_commands VALUES(?,?,?,?)",
						).run(runId, owner, conversationId, JSON.stringify(result));
				},
				resultInTransaction(db: Database, runId: string) {
					const r = db
						.query(
							"SELECT result_json FROM object_recognition_commands WHERE run_id=? AND owner=?",
						)
						.get(runId, owner) as { result_json: string } | null;
					return r ? JSON.parse(r.result_json) : null;
				},
				resultForCallInTransaction(db: Database, callId: string) {
					const r = db
						.query(
							"SELECT result_json FROM object_recognition_execution_commands WHERE call_id=? AND owner=?",
						)
						.get(callId, owner) as { result_json: string } | null;
					return r ? JSON.parse(r.result_json) : null;
				},
			};
		},
		recheck: (owner: string, id: string) =>
			store.write((db) => {
				const r = owned(db, id, owner);
				const v = record(r);
				if (!r.upstream_id || v.state !== "failed")
					throw new Error("recognition_not_ready");
				const state =
					v.errorCode === "recognition_cancel_unconfirmed"
						? "cancelling"
						: "running";
				db.query(
					"UPDATE object_recognition_inputs SET deadline=? WHERE id=?",
				).run(Date.now() + 600000, id);
				const updated = patch(db, id, { state, errorCode: null, result: null });
				enqueue(db, id, "poll");
				return updated;
			}),
		async remove(owner: string, id: string) {
			await store.write((db) => {
				const r = owned(db, id, owner);
				if (!["completed", "failed", "cancelled"].includes(record(r).state))
					throw new Error("recognition_not_ready");
				db.query("DELETE FROM object_recognition_inputs WHERE id=?").run(id);
			});
		},
		...createHandoffs(store),
	};
}
export type ObjectRecognitionService = ReturnType<
	typeof createObjectRecognition
>;
