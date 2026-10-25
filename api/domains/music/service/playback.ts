import { executionCallSession } from "../../tool-runtime";
import { parseLlmJson } from "../../../infrastructure/llm-json";
import type { Database } from "bun:sqlite";
import { z } from "zod";
import { musicRequest, type Prepared } from "../../capabilities";
import type { Receipt } from "../../inference";
import type { HandlerDefinition } from "../../queue";
import { trackQuery, type TrackQuery } from "../../larm";
import type { PlaylistRecord } from "../contracts";
import {
	playlistRow,
	playlistByRun,
	playlistRecordOf,
	patchPlaylist,
	playlists,
} from "../repository/playlists";
import { musicContext } from "./context";
import { openedTracks, playbackSchemaOf } from "./playback-tracks";
import type { createMusic } from "./index";
import type { ChildExecution } from "../../tool-runtime";
export function createPlayback(deps: Parameters<typeof createMusic>[0]) {
	const { store, queue, inference, capabilities } = deps;
	const fail = (
		db: Database,
		id: string,
		code: string,
		state: "failed" | "cancelled" = "failed",
	) => {
		const r = playlistRow(db, id);
		if (!r || playlistRecordOf(r).state !== "planning") return;
		patchPlaylist(db, id, { state, errorCode: code });
		if (state !== "cancelled" && !JSON.parse(r.request_json).execution)
			deps.onFinished(db, r.run_id);
	};
	type Input = {
		id: string;
		requestId: string;
		prepared: Prepared;
		request: unknown;
	};
	type Result = {
		receipt: Receipt;
		title: string;
		query: TrackQuery;
		trackIds: string[];
	};
	const handler: HandlerDefinition<{ id: string }, Input, Result> = {
		kind: "music.playback",
		payloadVersions: [1],
		schema: z.object({ id: z.string() }),
		recovery: "interrupt",
		resourceKey: "inference.llm",
		prepareInTransaction(db, claim) {
			const r = playlistRow(db, claim.payload.id);
			if (!r || playlistRecordOf(r).state !== "planning")
				return { status: "stale", reason: "playlist_not_planning" };
			if (!inference.captureControlInTransaction || !inference.executeControl)
				throw new Error("music_inference_unavailable");
			const prepared = JSON.parse(r.bindings_json) as Prepared;
			capabilities.validateInTransaction(db, prepared);
			const execution = JSON.parse(r.request_json).execution;
			if (execution && !deps.validateExecutionInTransaction?.(db, execution))
				throw new Error("execution_changed");
			const capture = {
				subject: `music:${r.id}:playback`,
				policySubject: r.run_id,
				deadline: Math.min(r.deadline - 15000, Date.now() + 45000),
				maxOutputTokens: 2048,
			};
			const requestId = execution
				? inference.captureUserControlInTransaction!(db, {
						...capture,
						subject: `music-task:${r.id}-playback`,
					})
				: inference.captureControlInTransaction(db, capture);
			return {
				status: "ready",
				input: {
					id: r.id,
					requestId,
					prepared,
					request: JSON.parse(r.request_json),
				},
			};
		},
		async execute(input, { signal }) {
			const library = deps.gateway().library;
			const tags = await library.tags(signal);
			const schema = playbackSchemaOf(input.prepared);
			const context = musicContext(
				input.prepared,
				{ request: input.request, libraryTags: tags.tags },
				schema,
			);
			const receipt = await inference.executeControl!(
				input.requestId,
				context.messages,
				signal,
				context.control,
				(
					input.request as {
						execution?: import("../../tool-runtime").ChildExecution;
					}
				).execution
					? executionCallSession(
							(
								input.request as {
									execution: import("../../tool-runtime").ChildExecution;
								}
							).execution,
						)
					: undefined,
			);
			let value: unknown;
			try {
				value = parseLlmJson(receipt.value);
			} catch {
				throw new Error("music_playback_invalid_json");
			}
			const parsed = schema.safeParse(value);
			if (!parsed.success) throw new Error("music_playback_invalid_contract");
			const plan = parsed.data;
			// The request's own tracks are opened as they are: no search, and each is checked against the library.
			const opened = await openedTracks(plan, input.request, deps, signal);
			if (opened)
				return {
					receipt,
					title: plan.title,
					query: trackQuery.parse({}),
					trackIds: opened,
				};
			const query = trackQuery.parse({
				q: plan.q,
				tags: plan.tags,
				...(plan.favorite === null ? {} : { favorite: plan.favorite }),
				sort: plan.sort,
				order: plan.order,
			});
			const data = await library.tracks(query, signal);
			return {
				receipt,
				title: plan.title,
				query,
				trackIds: data.tracks.map((t) => t.id),
			};
		},
		classify: () => "fail",
		settleInTransaction(db, claim, input, outcome) {
			const r = playlistRow(db, claim.payload.id);
			if (!r || playlistRecordOf(r).state !== "planning") return "stale";
			if (outcome.type !== "success" || !input) {
				fail(
					db,
					r.id,
					"errorCode" in outcome ? outcome.errorCode : "playlist_interrupted",
				);
				return "applied";
			}
			try {
				capabilities.validateInTransaction(db, input.prepared);
			} catch {
				fail(db, r.id, "capability_revoked");
				return "applied";
			}
			if (!inference.acceptInTransaction?.(db, outcome.result.receipt)) {
				fail(db, r.id, "playlist_invalidated");
				return "applied";
			}
			const { title, query, trackIds } = outcome.result;
			patchPlaylist(db, r.id, {
				state: "completed",
				title,
				query,
				trackIds,
				currentId: trackIds[0] ?? null,
			});
			if (!JSON.parse(r.request_json).execution) deps.onFinished(db, r.run_id);
			return "applied";
		},
		cancelInTransaction(db, job) {
			fail(db, job.payload.id, "cancel_requested", "cancelled");
		},
	};
	queue.registerHandler(handler);
	return {
		startInTransaction(
			db: Database,
			input: {
				runId: string;
				conversationId: string;
				question: string;
				originalRequest: string;
				deadline: number;
				execution?: ChildExecution;
			},
		) {
			const existing = input.execution
				? playlistRow(db, input.execution.id)
				: playlistByRun(db, input.runId);
			if (existing) return { id: existing.id, jobId: existing.queue_job_id! };
			const request = musicRequest.parse({ question: input.question }),
				id = input.execution?.id ?? crypto.randomUUID();
			if (
				input.execution &&
				!deps.validateExecutionInTransaction?.(db, input.execution)
			)
				throw new Error("execution_changed");
			const prepared = capabilities.prepareActiveByIdInTransaction(
				db,
				{ rootRunId: input.runId, taskId: id, cancelEpoch: 0 },
				"package:music.playback@2",
				request,
			);
			const now = Date.now();
			const view: PlaylistRecord = {
				kind: "playlist",
				id,
				runId: input.runId,
				conversationId: input.conversationId,
				state: "planning",
				title: "音楽ライブラリ",
				query: trackQuery.parse({}),
				trackIds: [],
				currentId: null,
				errorCode: null,
				createdAt: now,
				updatedAt: now,
			};
			db.query(
				"INSERT INTO music_playlists(id,run_id,conversation_id,record_json,request_json,bindings_json,deadline) VALUES(?,?,?,?,?,?,?)",
			).run(
				id,
				input.runId,
				input.conversationId,
				JSON.stringify(view),
				JSON.stringify({
					...request,
					originalRequest: input.originalRequest,
					...(input.execution
						? { execution: input.execution, references: input.execution.refs }
						: {}),
				}),
				JSON.stringify(prepared),
				input.deadline,
			);
			const { job } = queue.enqueueInTransaction(db, {
				scope: "music",
				kind: "music.playback",
				dedupeKey: `${id}:playback`,
				payload: { id },
				subjectRef: id,
				lane: "interactive",
				resourceKey: "inference.llm",
				maxAttempts: 1,
				deadlineAtMs: input.deadline - 15000,
			});
			db.query("UPDATE music_playlists SET queue_job_id=? WHERE id=?").run(
				job.id,
				id,
			);
			if (!input.execution) deps.onJob(db, input.runId, job.id);
			return { id, jobId: job.id };
		},
		resultInTransaction(db: Database, runId: string) {
			const r = playlistByRun(db, runId);
			return r ? playlistRecordOf(r) : null;
		},
		purgeCallInTransaction(db: Database, id: string) {
			db.query(
				"UPDATE music_playlists SET request_json=json_object('execution',json_object('id',id,'erased',1)) WHERE id=? AND json_extract(request_json,'$.execution') IS NOT NULL",
			).run(id);
		},
		resultForCallInTransaction(db: Database, id: string) {
			const r = playlistRow(db, id);
			return r ? playlistRecordOf(r) : null;
		},
		cancelCallInTransaction(db: Database, id: string) {
			const r = playlistRow(db, id);
			if (r?.queue_job_id && playlistRecordOf(r).state === "planning") {
				fail(db, id, "execution_cancelled", "cancelled");
				queue.cancelInTransaction(db, r.queue_job_id, "execution_cancelled");
			}
		},
		list: (conversationId: string) =>
			store.read((db) => playlists(db, conversationId)),
		get: (id: string) =>
			store.read((db) => {
				const r = playlistRow(db, id);
				return r ? playlistRecordOf(r) : null;
			}),
		async update(
			id: string,
			change: { query?: TrackQuery; currentId?: string | null },
		) {
			// Validate selected references against LARM, including tracks selected from subsequent pages.
			if (!store.read((db) => playlistRow(db, id))) return null;
			if (change.currentId)
				await deps
					.gateway()
					.library.detail(change.currentId, AbortSignal.timeout(15000));
			return store.write((db) => {
				const r = playlistRow(db, id);
				if (!r) return null;
				const old = playlistRecordOf(r);
				if (old.state !== "completed")
					throw new Error("playlist_not_completed");
				return patchPlaylist(db, id, {
					...change,
					...(change.query ? { trackIds: [], currentId: null } : {}),
				});
			});
		},
	};
}
