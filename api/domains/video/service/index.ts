import type { Database } from "bun:sqlite";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import { VideoHttpError, type VideoClient } from "../../larm";
import type { QueueService } from "../../queue";
import {
	videoInput,
	videoRequestMetadata,
	videoRequestView,
	type VideoAdmission,
	type VideoInput,
	type VideoRequestView,
} from "../contracts";
import {
	admissionRow,
	byRequest,
	insert,
	jobOf,
	latest,
	patch,
	row,
	type VideoRow,
} from "../repository";
import { active, registerVideoJobs, saveJob } from "./handlers";

function view(r: VideoRow): VideoRequestView {
	const saved = jobOf(r);
	const job = saved ? videoRequestView.shape.job.unwrap().parse(saved) : null;
	return {
		id: r.id,
		title: videoInput.parse(JSON.parse(r.input_json)).title,
		state: r.state,
		job,
		errorCode: r.error_code,
		revision: r.revision,
	};
}
function admission(r: VideoRow | null): VideoAdmission {
	if (r?.state === "unconfirmed") return { state: "unconfirmed" };
	if (r?.state === "submitting" || r?.state === "tracking")
		return { state: "active" };
	if (r?.error_code === "worker_stop_failed") return { state: "isolated" };
	return { state: "idle" };
}
const missing = () => new VideoHttpError(404, "video_not_found");

export function createVideo(deps: {
	store: SqliteStore;
	queue: QueueService;
	port: () => VideoClient | null;
}) {
	const { store } = deps;
	const enqueue = registerVideoJobs(deps);
	const connection = () => {
		const port = deps.port();
		if (!port) throw new VideoHttpError(503, "not_configured");
		return port;
	};
	function byId(db: Database, id: string, port: VideoClient) {
		const r = row(db, id);
		if (!r) throw missing();
		if (r.binding !== port.binding)
			throw new VideoHttpError(409, "video_connection_changed");
		return r;
	}
	function snapshotInTransaction(db: Database) {
		const port = deps.port();
		const request = port ? latest(db, port.binding) : null;
		return {
			request: request ? view(request) : null,
			admission: admission(port ? admissionRow(db, port.binding) : null),
		};
	}
	function startInTransaction(
		db: Database,
		ref: string,
		key: string,
		input: VideoInput,
	) {
		const port = connection();
		const body = JSON.stringify(videoInput.parse(input));
		const previous = byRequest(db, ref) ?? row(db, key);
		if (previous) {
			if (previous.input_json !== body)
				throw new VideoHttpError(409, "idempotency_conflict");
			if (previous.binding !== port.binding)
				throw new VideoHttpError(409, "video_connection_changed");
			return { request: view(previous), replay: true };
		}
		const state = admission(admissionRow(db, port.binding)).state;
		if (state === "active") throw new VideoHttpError(409, "on_demand_busy");
		if (state === "unconfirmed")
			throw new VideoHttpError(409, "video_acceptance_unconfirmed");
		insert(db, key, ref, port.binding, body);
		const saved = row(db, key)!;
		enqueue(db, saved, "submit");
		return { request: view(saved), replay: false };
	}
	async function savedVideo(id: string, signal: AbortSignal) {
		const port = connection();
		const item = (await port.list(signal)).find((v) => v.id === id);
		if (!item) throw missing();
		return { port, item };
	}
	return {
		available: () => deps.port() !== null,
		snapshotInTransaction,
		startInTransaction,
		readCommandInTransaction: (db: Database, ref: string) => {
			const r = byRequest(db, ref);
			return r ? view(r) : null;
		},
		snapshot: () => store.readSnapshot(snapshotInTransaction),
		submit: (key: string, input: VideoInput) =>
			store.write((db) => startInTransaction(db, key, key, input).request),
		async discover(signal: AbortSignal) {
			const port = connection();
			const { path, model, description } = await port.discover(signal);
			return { model, description, options: await port.options(path, signal) };
		},
		admission: () =>
			store.readSnapshot((db) => {
				const port = deps.port();
				return admission(port ? admissionRow(db, port.binding) : null);
			}),
		async reconcile(id: string) {
			const port = connection();
			return store.write((db) => {
				const r = byId(db, id, port);
				if (r.state !== "unconfirmed") return view(r);
				patch(db, id, {
					state: r.job_json ? "tracking" : "submitting",
					retry_at: 0,
					error_code: null,
				});
				const next = row(db, id)!;
				enqueue(db, next, r.job_json ? "poll" : "submit");
				return view(next);
			});
		},
		async cancel(id: string, signal: AbortSignal) {
			const port = connection();
			const existing = store.read((db) => byId(db, id, port));
			const job = jobOf(existing);
			if (!job) throw new VideoHttpError(409, "video_acceptance_unconfirmed");
			if (!active(job) || job.phase === "stopping") return view(existing);
			const update = await port.status(job, signal, true);
			return store.write(
				(db) => {
					const current = byId(db, id, port);
					if (saveJob(db, current, update)) {
						const next = row(db, id)!;
						if (next.state === "tracking") enqueue(db, next, "poll");
						return view(next);
					}
					return view(current);
				},
				{ reserved: true },
			);
		},
		list: (signal: AbortSignal) => connection().list(signal),
		async metadata(id: string, signal: AbortSignal) {
			const { port, item } = await savedVideo(id, signal);
			const { request, ...metadata } = await port.metadata(item, signal);
			const input = videoRequestMetadata.safeParse(request);
			return { ...metadata, request: input.success ? input.data : undefined };
		},
		async content(id: string, range: string | undefined, signal: AbortSignal) {
			const { port, item } = await savedVideo(id, signal);
			return port.content(item, range, signal);
		},
		remove: (id: string, signal: AbortSignal) =>
			connection().remove(id, signal),
	};
}
export type VideoService = ReturnType<typeof createVideo>;
