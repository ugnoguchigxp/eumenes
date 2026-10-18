import { createHash } from "node:crypto";
import {
	createMonitoringClient,
	MONITORING_BODY_LIMIT,
	type MonitoringRead,
} from "../../larm";
import type { MonitoringEvent } from "../../larm/contracts";
import {
	emptyLarm,
	type LarmReadStatus,
	type LarmView,
} from "../contracts/larm";
import type { LarmRepository } from "../repository";
import { larmView, rememberGap } from "./larm-history";

export type LarmCollectorConfig = {
	baseUrl: string | null;
	token: string | undefined;
};
export const LARM_POLL_MS = 60_000;
/** 100k upstream events / 500 per page; 64MiB upstream storage. Bound one cycle to 15s. */
const MAX_PAGES = 200,
	MAX_BYTES = 67_108_864,
	CYCLE_MS = 15_000;
type ClientFactory = typeof createMonitoringClient;

export function createLarmCollector(deps: {
	config(): LarmCollectorConfig;
	repository: LarmRepository;
	onChange?(notify: () => void): () => void;
	now?: () => number;
	createClient?: ClientFactory;
}) {
	const now = deps.now ?? Date.now;
	let source:
		| { key: string; config: LarmCollectorConfig; lifetime: AbortController }
		| undefined;
	let flight: { key: string; promise: Promise<void> } | undefined;
	let closed = false;
	function reconcile() {
		const config = deps.config();
		const key = createHash("sha256")
			.update(JSON.stringify([config.baseUrl, config.token]))
			.digest("hex");
		if (source?.key !== key) {
			source?.lifetime.abort();
			source = { key, config, lifetime: new AbortController() };
		}
		return source;
	}
	const unsubscribe = deps.onChange?.(() => {
		if (!closed) reconcile();
	});
	async function collect(active: NonNullable<typeof source>) {
		const state = deps.repository.read(active.key);
		const current = () => {
			active.lifetime.signal.throwIfAborted();
			if (closed || reconcile().key !== active.key)
				throw new DOMException("Monitoring source changed", "AbortError");
		};
		const save = (events: readonly MonitoringEvent[] = []) =>
			deps.repository.save(active.key, state, events, current);
		state.nextPollAt = now() + LARM_POLL_MS;
		await save();
		const client = (deps.createClient ?? createMonitoringClient)({
			baseUrl: active.config.baseUrl!,
			token: active.config.token!,
			lifetime: active.lifetime.signal,
			now,
		});
		const deadline = AbortSignal.timeout(CYCLE_MS);
		function status<T>(result: MonitoringRead<T>): LarmReadStatus {
			state.nextPollAt = Math.max(
				state.nextPollAt,
				now() + (result.retryAfterMs ?? 0),
			);
			return {
				status: result.status,
				at: now(),
				...(result.httpStatus ? { httpStatus: result.httpStatus } : {}),
				...(result.errorCode ? { code: result.errorCode } : {}),
				...(result.reasonCode ? { reasonCode: result.reasonCode } : {}),
				...(result.retryAfterMs !== undefined
					? { retryAfterMs: result.retryAfterMs }
					: {}),
			};
		}
		const snapshotRequestedAt = now();
		const snapshot = await client.snapshot(deadline);
		current();
		state.snapshotStatus = status(snapshot);
		if (snapshot.data) {
			if (state.bootEpoch && state.bootEpoch !== snapshot.data.bootEpoch) {
				rememberGap(state, "monitoring_epoch_changed", now());
				state.cursor = null;
				state.page = undefined;
			}
			state.bootEpoch = snapshot.data.bootEpoch;
			state.snapshot = snapshot.data;
			state.snapshotReceivedAt = now();
			state.snapshotRequestedAt = snapshotRequestedAt;
			if (snapshot.data.eventStream.continuity === "gap")
				rememberGap(state, "stream_gap", now());
		}
		await save();
		let bytes = snapshot.bytes ?? 0;
		for (
			let pageNumber = 0;
			pageNumber < MAX_PAGES &&
			!deadline.aborted &&
			bytes + MONITORING_BODY_LIMIT <= MAX_BYTES;
			pageNumber++
		) {
			const page = await client.events(state.cursor, deadline);
			current();
			state.eventsStatus = status(page);
			if (!page.data) {
				if (
					page.errorCode === "monitoring_cursor_expired" ||
					page.errorCode === "monitoring_epoch_changed"
				) {
					rememberGap(state, page.errorCode, now(), page.reasonCode);
					state.cursor = null;
					state.page = undefined;
					if (page.errorCode === "monitoring_epoch_changed" && page.bootEpoch)
						state.bootEpoch = page.bootEpoch;
				}
				await save();
				return;
			}
			const p = page.data;
			if (state.bootEpoch && p.bootEpoch !== state.bootEpoch) {
				rememberGap(state, "epoch_mismatch", now());
				state.cursor = null;
				state.page = undefined;
				state.eventsStatus = { status: "epoch_mismatch", at: now() };
				await save();
				return;
			}
			const previous = state.page;
			if (
				(previous?.hasMore &&
					(JSON.stringify(previous.window) !== JSON.stringify(p.window) ||
						previous.eventStream.streamId !== p.eventStream.streamId)) ||
				(p.hasMore && p.nextCursor === state.cursor) ||
				p.events.some(
					(e) =>
						e.streamId !== p.eventStream.streamId ||
						BigInt(e.sequence) > BigInt(p.window.highWaterSequence),
				)
			) {
				state.eventsStatus = { status: "invalid_response", at: now() };
				await save();
				return;
			}
			state.bootEpoch ??= p.bootEpoch;
			if (p.eventStream.continuity === "gap")
				rememberGap(state, "stream_gap", now());
			if (
				p.coverage.some((c) =>
					["permission_denied", "error", "unavailable", "stale"].includes(
						c.status,
					),
				)
			)
				rememberGap(state, "coverage_gap", now());
			const { events, ...metadata } = p;
			state.page = metadata;
			state.cursor = p.nextCursor;
			state.eventsStatus = {
				status: p.hasMore ? "catching_up" : "ok",
				at: now(),
			};
			bytes += page.bytes ?? 0;
			await save(events);
			if (!p.hasMore) return;
		}
		state.eventsStatus = {
			status: deadline.aborted ? "timeout" : "catching_up",
			at: now(),
		};
		await save();
	}
	return {
		async read(): Promise<LarmView> {
			if (closed) throw new Error("monitoring_closed");
			const active = reconcile();
			if (!active.config.baseUrl || !active.config.token) {
				const state = emptyLarm(now());
				state.snapshotStatus = state.eventsStatus = {
					status: "unconfigured",
					at: now(),
				};
				return larmView(state, []);
			}
			const stored = deps.repository.read(active.key);
			if (stored.nextPollAt <= now() || flight?.key === active.key) {
				if (flight?.key !== active.key) {
					const promise = collect(active).catch(async (error) => {
						if (active.lifetime.signal.aborted || closed) return;
						if (
							error instanceof DOMException &&
							error.name === "TimeoutError"
						) {
							const state = deps.repository.read(active.key);
							state.eventsStatus = { status: "timeout", at: now() };
							await deps.repository.save(active.key, state, [], () =>
								active.lifetime.signal.throwIfAborted(),
							);
							return;
						}
						throw error;
					});
					flight = { key: active.key, promise };
					void promise
						.finally(() => {
							if (flight?.promise === promise) flight = undefined;
						})
						.catch(() => {});
				}
				await flight!.promise;
			}
			if (reconcile().key !== active.key) return this.read();
			const state = deps.repository.read(active.key);
			return larmView(state, deps.repository.events(active.key));
		},
		async close() {
			closed = true;
			unsubscribe?.();
			source?.lifetime.abort();
			await flight?.promise;
		},
	};
}
export type LarmCollector = ReturnType<typeof createLarmCollector>;
