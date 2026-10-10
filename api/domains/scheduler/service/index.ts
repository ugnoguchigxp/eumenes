import { getLogger } from "../../../infrastructure/logger";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import { canonicalJson, sha256Hex } from "../../../infrastructure/digest";
import type { QueueService, Tx } from "../../queue";
import type { CreateSchedule, OccurrenceDto, ScheduleDto } from "../contracts";
import {
	advanceSchedule,
	countActive,
	countLive,
	dueSchedules,
	getByRequest,
	getSchedule,
	insertOccurrence,
	insertSchedule,
	lastDispatchedJob,
	listOccurrences,
	listSchedules,
	nextDueAt,
	type OccurrenceRecord,
	type ScheduleRecord,
	setDeferReason,
	transitionSchedule,
} from "../repository";
import type { SchedulerOptions, TargetDefinition } from "../types";
import { firstBoundaryAfter, firstBoundaryAtOrAfter, planFire } from "./clock";

const log = getLogger("scheduler");
const code = (error: unknown) =>
	error instanceof Error && /^[a-z_]{1,80}$/.test(error.message)
		? error.message
		: "scheduler_failed";
const iso = (ms: number) => new Date(ms).toISOString();
const OPEN_JOB = ["queued", "running", "retry_wait", "cancel_requested"];
const MAX_ABS_MS = 8.64e15 / 2;

function toDto(s: ScheduleRecord): ScheduleDto {
	return {
		id: s.id,
		requestId: s.requestId,
		scope: s.scope,
		targetKind: s.targetKind,
		targetVersion: s.targetVersion,
		targetPayload: JSON.parse(s.targetPayloadJson),
		state: s.state,
		revision: s.revision,
		mode: s.mode,
		anchorAt: iso(s.anchorAtMs),
		intervalMs: s.intervalMs,
		nextDueAt: iso(s.nextDueAtMs),
		misfirePolicy: s.misfirePolicy,
		graceMs: s.graceMs,
		overlapPolicy: s.overlapPolicy,
		deferReason: s.deferReason,
		createdAt: iso(s.createdAtMs),
		updatedAt: iso(s.updatedAtMs),
	};
}
const canonical = (value: unknown) =>
	canonicalJson(value, { omitUndefined: true, keyOrder: "codeUnit" });
function cursorOf(value: string | null): number | null {
	if (value === null) return null;
	const n = Number(value);
	if (!Number.isInteger(n)) throw new Error("invalid_cursor");
	return n;
}

type FireResult = "none" | "dispatched" | "skipped" | "deferred";
function defaultSleep(ms: number, signal?: AbortSignal) {
	return new Promise<void>((resolve) => {
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				resolve();
			},
			{ once: true },
		);
	});
}

export function createScheduler(
	store: SqliteStore,
	queue: QueueService,
	options: SchedulerOptions = {},
) {
	const now = options.now ?? Date.now;
	const newId = options.id ?? (() => crypto.randomUUID());
	const pollMs = options.pollMs ?? 1000;
	const tickLimit = options.tickLimit ?? 32;
	const maxSchedules = options.maxSchedules ?? 256;
	const deferMs = options.capacityBackoffMs ?? 2000;
	const sleep = options.sleep ?? defaultSleep;
	const targets = new Map<string, TargetDefinition<unknown>>();
	const retryAfter = new Map<string, number>();
	const failures = new Map<string, number>();
	let closing = false;
	let loopPromise: Promise<void> | null = null;
	let deferred = defer();
	let chain: Promise<unknown> = Promise.resolve();

	function defer() {
		let resolve: () => void = () => {};
		const promise = new Promise<void>((r) => {
			resolve = r;
		});
		return { promise, resolve };
	}
	function wake() {
		const current = deferred;
		deferred = defer();
		current.resolve();
	}

	function fireInTransaction(
		db: Tx,
		id: string,
		revision: number,
		at: number,
	): FireResult {
		const s = getSchedule(db, id);
		if (!s || s.state !== "active" || s.revision !== revision) return "none";
		if (s.nextDueAtMs > at) return "none";
		const target = targets.get(s.targetKind);
		if (!target || target.version !== s.targetVersion) {
			setDeferReason(db, s.id, "target_not_registered", at);
			return "deferred";
		}
		const plan = planFire(s, at);
		const record = (
			state: OccurrenceRecord["state"],
			reason: string | null,
			job: { jobId: string; subjectRef: string | null } | null,
			occurrenceId: string,
		) =>
			insertOccurrence(db, {
				id: occurrenceId,
				scheduleId: s.id,
				scheduleRevision: s.revision,
				scheduledAtMs: plan.scheduledAtMs,
				state,
				jobId: job?.jobId ?? null,
				subjectRef: job?.subjectRef ?? null,
				reason,
				createdAtMs: at,
			});
		const foldedNote = plan.missed > 0 ? `+${plan.missed} earlier` : null;
		const occurrenceId = newId();
		let result: FireResult;
		if (s.misfirePolicy === "skip" && plan.lateMs > s.graceMs) {
			record(
				"skipped",
				`misfire_skipped${foldedNote ? ` (${foldedNote})` : ""}`,
				null,
				occurrenceId,
			);
			result = "skipped";
		} else {
			const previousJob = lastDispatchedJob(db, s.id);
			const previous = previousJob
				? queue.getInTransaction(db, previousJob)
				: null;
			if (previous && OPEN_JOB.includes(previous.state)) {
				record("skipped", "overlap", null, occurrenceId);
				result = "skipped";
			} else {
				db.exec("SAVEPOINT scheduler_materialize");
				try {
					const job = target.materializeInTransaction(db, {
						scheduleId: s.id,
						occurrenceId,
						scheduledAtMs: plan.scheduledAtMs,
						payload: JSON.parse(s.targetPayloadJson),
					});
					db.exec("RELEASE scheduler_materialize");
					record(
						"dispatched",
						foldedNote ? `coalesced (${foldedNote})` : null,
						job,
						occurrenceId,
					);
					result = "dispatched";
				} catch (error) {
					db.exec("ROLLBACK TO scheduler_materialize");
					db.exec("RELEASE scheduler_materialize");
					const message = error instanceof Error ? error.message : "";
					if (
						message === "queue_full" ||
						message === "database_writer_queue_full"
					)
						throw new CapacityDeferred(message);
					record("skipped", "target_failed", null, occurrenceId);
					result = "skipped";
				}
			}
		}
		advanceSchedule(db, s.id, s.revision, plan.nextDueAtMs, at);
		return result;
	}
	class CapacityDeferred extends Error {}

	async function fireOne(id: string, revision: number): Promise<FireResult> {
		const at = now();
		try {
			const result = await store.write((db) =>
				fireInTransaction(db, id, revision, at),
			);
			if (result === "deferred") retryAfter.set(id, at + deferMs);
			else retryAfter.delete(id);
			failures.delete(id);
			return result;
		} catch (error) {
			if (error instanceof CapacityDeferred || isBusy(error)) {
				// Queue/Writer full is not a skip: keep the schedule due and re-judge later.
				retryAfter.set(id, at + deferMs);
				await store
					.write((db) =>
						setDeferReason(
							db,
							id,
							error instanceof Error ? error.message : "deferred",
							at,
						),
					)
					.catch(() => {});
				return "deferred";
			}
			// Unexpected failure: do not let one schedule starve the others.
			log.warn("scheduler.fire_failed", { reason: code(error) }, error);
			const n = failures.get(id) ?? 0;
			failures.set(id, n + 1);
			const jitter = Math.floor(Math.random() * deferMs);
			retryAfter.set(id, at + Math.min(300_000, deferMs * 2 ** n) + jitter);
			await store
				.write((db) => setDeferReason(db, id, "unexpected_failure", at))
				.catch(() => {});
			return "deferred";
		}
	}
	function isBusy(error: unknown) {
		return (
			error instanceof Error && error.message === "database_writer_queue_full"
		);
	}

	async function tickInner() {
		const at = now();
		const allDue = store.read((db) =>
			dueSchedules(db, at, Math.max(countActive(db), tickLimit)),
		);
		const dueIds = new Set(allDue.map((d) => d.id));
		for (const id of retryAfter.keys())
			if (!dueIds.has(id)) retryAfter.delete(id);
		for (const id of failures.keys()) if (!dueIds.has(id)) failures.delete(id);
		const due = allDue
			.filter((d) => (retryAfter.get(d.id) ?? 0) <= at)
			.slice(0, tickLimit);
		let dispatched = 0;
		for (const d of due) {
			if (closing) break;
			if ((await fireOne(d.id, d.revision)) === "dispatched") dispatched++;
		}
		if (dispatched > 0) queue.wake();
		return due.length;
	}
	function tick() {
		const run = chain.then(tickInner, tickInner);
		chain = run.catch(() => {});
		return run;
	}
	async function loop() {
		while (!closing) {
			const mine = deferred;
			let delay = pollMs;
			try {
				const fired = await tick();
				const next = store.read((db) => nextDueAt(db));
				if (next !== null) {
					const at = now();
					// Due-but-deferred schedules wait for their retry time instead of spinning.
					const future = [...retryAfter.values()].filter((t) => t > at);
					const wait =
						next <= at
							? future.length
								? Math.min(...future) - at
								: pollMs
							: next - at;
					delay = Math.max(10, Math.min(pollMs, wait));
					// A full batch means more due schedules are likely waiting: keep
					// draining at once. pollMs stays for due-but-not-fireable ones.
					if (fired >= tickLimit && next <= at) delay = 10;
				}
			} catch (error) {
				log.warn("scheduler.tick_failed", { reason: code(error) }, error);
				delay = Math.min(pollMs, deferMs);
			}
			if (closing) break;
			const timer = new AbortController();
			await Promise.race([mine.promise, sleep(delay, timer.signal)]);
			timer.abort();
		}
	}

	function transitionOp(
		id: string,
		expectedRevision: number,
		from: ScheduleRecord["state"][],
		to: ScheduleRecord["state"],
		nextDue: (s: ScheduleRecord, at: number) => number | null,
	) {
		return store
			.write((db) => {
				const s = getSchedule(db, id);
				if (!s) return null;
				if (s.revision !== expectedRevision)
					throw new Error("revision_conflict");
				if (!from.includes(s.state)) throw new Error("schedule_state_conflict");
				const at = now();
				if (
					!transitionSchedule(
						db,
						id,
						expectedRevision,
						from,
						to,
						nextDue(s, at),
						at,
					)
				)
					throw new Error("revision_conflict");
				return getSchedule(db, id);
			})
			.then((s) => {
				wake();
				return s ? toDto(s) : null;
			});
	}

	function createInTransaction(db: Tx, input: CreateSchedule): ScheduleDto {
		const target = targets.get(input.target.kind);
		if (!target) throw new Error("invalid_unknown_target");
		const payload = target.schema.safeParse(input.target.payload);
		if (!payload.success) throw new Error("invalid_target_payload");
		const mode = input.schedule.type;
		const first = Date.parse(
			input.schedule.type === "once"
				? input.schedule.at
				: input.schedule.anchor,
		);
		if (!Number.isFinite(first) || Math.abs(first) > MAX_ABS_MS)
			throw new Error("invalid_schedule_time");
		const intervalMs =
			input.schedule.type === "interval" ? input.schedule.intervalMs : null;
		const digest = sha256Hex(
			canonical({
				kind: target.kind,
				version: target.version,
				payload: payload.data,
				mode,
				first,
				intervalMs,
				misfire: input.misfirePolicy,
				grace: input.graceMs,
			}),
		);
		const existing = getByRequest(db, input.requestId);
		if (existing) {
			if (existing.inputDigest !== digest) throw new Error("request_conflict");
			return toDto(existing);
		}
		if (countLive(db) >= maxSchedules)
			throw new Error("schedule_limit_reached");
		target.validateInTransaction?.(db, payload.data);
		const at = now();
		const nextDue =
			intervalMs === null
				? first
				: firstBoundaryAtOrAfter(first, intervalMs, at);
		return toDto(
			insertSchedule(db, {
				id: newId(),
				requestId: input.requestId,
				inputDigest: digest,
				scope: "default",
				targetKind: target.kind,
				targetVersion: target.version,
				targetPayloadJson: canonical(payload.data),
				state: "active",
				revision: 0,
				mode,
				anchorAtMs: first,
				intervalMs,
				nextDueAtMs: nextDue,
				misfirePolicy: input.misfirePolicy,
				graceMs: input.graceMs,
				createdAtMs: at,
				updatedAtMs: at,
			}),
		);
	}

	return {
		registerTarget<P>(definition: TargetDefinition<P>) {
			if (targets.has(definition.kind))
				throw new Error(`invalid_duplicate_target:${definition.kind}`);
			targets.set(definition.kind, definition as TargetDefinition<unknown>);
		},
		createInTransaction,
		async create(input: CreateSchedule): Promise<ScheduleDto> {
			const created = await store.write((db) => createInTransaction(db, input));
			wake();
			return created;
		},
		getInTransaction(db: Tx, id: string): ScheduleDto | null {
			const s = getSchedule(db, id);
			return s ? toDto(s) : null;
		},
		cancelInTransaction(db: Tx, id: string, expectedRevision: number) {
			const s = getSchedule(db, id);
			if (!s) throw new Error("invalid_schedule_id");
			if (s.revision !== expectedRevision) throw new Error("revision_conflict");
			if (!["active", "paused"].includes(s.state))
				throw new Error("schedule_state_conflict");
			if (
				!transitionSchedule(
					db,
					id,
					expectedRevision,
					["active", "paused"],
					"cancelled",
					null,
					now(),
				)
			)
				throw new Error("revision_conflict");
			return toDto(getSchedule(db, id)!);
		},
		get(id: string): ScheduleDto | null {
			const s = store.read((db) => getSchedule(db, id));
			return s ? toDto(s) : null;
		},
		list(state?: string, cursor: string | null = null, limit = 50) {
			const size = Math.min(100, Math.max(1, limit));
			const rows = store.read((db) =>
				listSchedules(db, state, cursorOf(cursor), size + 1),
			);
			const page = rows.slice(0, size);
			return {
				items: page.map(toDto),
				nextCursor: rows.length > size ? String(page.at(-1)?.createdSeq) : null,
			};
		},
		listOccurrences(id: string, cursor: string | null = null, limit = 50) {
			const size = Math.min(100, Math.max(1, limit));
			const rows = store.read((db) =>
				listOccurrences(db, id, cursorOf(cursor), size + 1),
			);
			const page = rows.slice(0, size);
			const items: OccurrenceDto[] = page.map((o) => ({
				id: o.id,
				scheduleId: o.scheduleId,
				scheduleRevision: o.scheduleRevision,
				scheduledAt: iso(o.scheduledAtMs),
				state: o.state,
				jobId: o.jobId,
				subjectRef: o.subjectRef,
				jobState: o.jobId ? (queue.get(o.jobId)?.state ?? null) : null,
				reason: o.reason,
				createdAt: iso(o.createdAtMs),
			}));
			return {
				items,
				nextCursor: rows.length > size ? String(page.at(-1)?.seq) : null,
			};
		},
		pause: (id: string, expectedRevision: number) =>
			transitionOp(id, expectedRevision, ["active"], "paused", () => null),
		/** Interval schedules resume at the next future boundary; stopped periods are not replayed. */
		resume: (id: string, expectedRevision: number) =>
			transitionOp(id, expectedRevision, ["paused"], "active", (s, at) =>
				s.mode === "interval" && s.intervalMs !== null
					? firstBoundaryAfter(s.anchorAtMs, s.intervalMs, at)
					: null,
			),
		/** Stops future occurrences only; already registered jobs are not cancelled. */
		cancel: (id: string, expectedRevision: number) =>
			transitionOp(
				id,
				expectedRevision,
				["active", "paused"],
				"cancelled",
				() => null,
			),
		/** Process due schedules once (also used by the loop). Returns how many were due. */
		tick,
		wake,
		async recover() {
			return {
				active: store.read((db) => countActive(db)),
			};
		},
		start() {
			if (!loopPromise && !closing) loopPromise = loop();
		},
		async close() {
			if (closing) return;
			closing = true;
			wake();
			await loopPromise?.catch(() => {});
			await chain.catch(() => {});
		},
	};
}
export type SchedulerService = ReturnType<typeof createScheduler>;
