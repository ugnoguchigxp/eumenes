import { createPlayback } from "./playback";
import type { Database } from "bun:sqlite";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import { musicRequest, type Capabilities } from "../../capabilities";
import type { InferencePort } from "../../inference";
import type { QueueService } from "../../queue";
import type { LarmPlayground } from "../../larm";
import type { MusicRecord } from "../contracts";
import {
	row,
	byRun,
	byTrack,
	record,
	patch,
	list,
	media,
	activity,
} from "../repository";
import { registerMusicHandlers } from "./handlers";
import { createArtwork } from "./artwork";
import type { ChildExecution } from "../../tool-runtime";
/** Read-only source for registered music screens; the music domain owns this query. */
export const musicListInTransaction = (db: Database, conversationId: string) =>
	list(db, conversationId);
const active = (r: MusicRecord) =>
	r.state === "planning" || r.state === "generating";
export function createMusic(deps: {
	store: SqliteStore;
	queue: QueueService;
	inference: InferencePort;
	capabilities: Capabilities;
	gateway: () => LarmPlayground;
	onJob: (db: Database, runId: string, jobId: string) => void;
	onFinished: (db: Database, runId: string) => void;
	validateExecutionInTransaction?: (
		db: Database,
		child: ChildExecution,
	) => boolean;
}) {
	const { store, queue, capabilities } = deps;
	function enqueue(
		db: Database,
		id: string,
		runId: string,
		deadline: number,
		stage: "plan" | "generate",
	) {
		const { job } = queue.enqueueInTransaction(db, {
			scope: "music",
			kind: `music.${stage}`,
			dedupeKey: `${id}:${stage}`,
			payload: { id },
			subjectRef: id,
			lane: "interactive",
			resourceKey: stage === "plan" ? "inference.llm" : "music.generate",
			maxAttempts: 1,
			deadlineAtMs: deadline - 15000,
		});
		db.query("UPDATE music_generations SET queue_job_id=? WHERE id=?").run(
			job.id,
			id,
		);
		if (!JSON.parse(row(db, id)!.request_json).execution)
			deps.onJob(db, runId, job.id);
		return job.id;
	}
	function fail(db: Database, id: string, code: string) {
		const r = row(db, id);
		if (!r || !active(record(r))) return;
		const state = code === "provider_cancelled" ? "cancelled" : "failed";
		patch(db, id, { state, errorCode: code, phase: state });
		if (!JSON.parse(r.request_json).execution) deps.onFinished(db, r.run_id);
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
	registerMusicHandlers({ ...deps, enqueue, fail, cancel });
	const playback = createPlayback(deps);
	const artwork = createArtwork(deps);
	return {
		playback,
		musicProviders: (signal: AbortSignal) =>
			deps.gateway().musicProviders(signal),
		requestArtwork: artwork.request,
		artwork: artwork.content,
		library: () => deps.gateway().library,
		startPlaybackInTransaction: playback.startInTransaction,
		startInTransaction(
			db: Database,
			input: {
				runId: string;
				conversationId: string;
				question: string;
				originalRequest: string;
				priorSteps?: unknown[];
				deadline: number;
				execution?: ChildExecution;
			},
		) {
			const existing = input.execution
				? row(db, input.execution.id)
				: byRun(db, input.runId);
			if (existing) return { id: existing.id, jobId: existing.queue_job_id! };
			const request = musicRequest.parse({ question: input.question });
			if (
				input.execution &&
				!deps.validateExecutionInTransaction?.(db, input.execution)
			)
				throw new Error("execution_changed");
			const id = input.execution?.id ?? crypto.randomUUID();
			const prepared = capabilities.prepareActiveByIdInTransaction(
				db,
				{ rootRunId: input.runId, taskId: id, cancelEpoch: 0 },
				"package:music.create@3",
				request,
			);
			const now = Date.now();
			const view: MusicRecord = {
				id,
				runId: input.runId,
				conversationId: input.conversationId,
				state: "planning",
				title: "楽曲",
				description: "",
				prompt: null,
				durationSeconds: null,
				phase: "planning",
				jobId: null,
				errorCode: null,
				mime: null,
				actualModel: null,
				createdAt: now,
				updatedAt: now,
			};
			db.query(
				"INSERT INTO music_generations(id,run_id,conversation_id,record_json,request_json,bindings_json,deadline) VALUES(?,?,?,?,?,?,?)",
			).run(
				id,
				input.runId,
				input.conversationId,
				JSON.stringify(view),
				JSON.stringify({
					...request,
					originalRequest: input.originalRequest,
					...(input.priorSteps?.length ? { priorSteps: input.priorSteps } : {}),
					...(input.execution
						? { execution: input.execution, references: input.execution.refs }
						: {}),
				}),
				JSON.stringify(prepared),
				input.deadline,
			);
			return {
				id,
				jobId: enqueue(db, id, input.runId, input.deadline, "plan"),
			};
		},
		resultInTransaction(db: Database, runId: string) {
			const r = byRun(db, runId);
			return r ? record(r) : playback.resultInTransaction(db, runId);
		},
		purgeCallInTransaction(db: Database, id: string) {
			db.query(
				"UPDATE music_generations SET request_json=json_object('execution',json_object('id',id,'erased',1)) WHERE id=? AND json_extract(request_json,'$.execution') IS NOT NULL",
			).run(id);
		},
		resultForCallInTransaction(db: Database, id: string) {
			const r = row(db, id);
			return r ? record(r) : playback.resultForCallInTransaction(db, id);
		},
		cancelCallInTransaction(db: Database, id: string) {
			const r = row(db, id);
			if (r?.queue_job_id && active(record(r))) {
				cancel(db, { payload: { id } });
				queue.cancelInTransaction(db, r.queue_job_id, "execution_cancelled");
			}
			playback.cancelCallInTransaction(db, id);
		},
		get: (id: string) =>
			store.read((db) => {
				const r = row(db, id);
				return r ? record(r) : null;
			}),
		/** The generation behind a library track, so the playlist can reuse its artwork. */
		trackGeneration: (trackId: string) =>
			store.read((db) => {
				const r = byTrack(db, trackId);
				if (!r) return null;
				const { id, artwork, task, runtime } = record(r);
				return {
					id,
					...(artwork ? { artwork } : {}),
					...(task ? { task } : {}),
					...(runtime ? { runtime } : {}),
				};
			}),
		list: (conversationId: string) =>
			store.read((db) => list(db, conversationId)),
		activity: (since: number) => store.read((db) => activity(db, since)),
		audio: (id: string) =>
			store.read((db) => {
				const r = row(db, id);
				const audio =
					r && record(r).state === "completed" && media(db, id, "audio");
				return audio && audio.bytes
					? { bytes: audio.bytes, mime: record(r).mime! }
					: null;
			}),
	};
}
export type MusicService = ReturnType<typeof createMusic>;
