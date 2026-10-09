import type { Database } from "bun:sqlite";
import {
	createConversationSourceAdapter,
	createWorldExtraction,
	type ExtractionInference,
	type ExtractionOptions,
	type ExtractionQueue,
	type ExtractionHandler,
	type PreparedExtraction,
	type WorldExtraction,
} from "..";
import { PURPOSE, SCOPE, TEST_CURSOR_SECRET } from "./fixture";
import type { Life } from "./lifecycle-fixture";

export type SettleOutcomeOf = Parameters<
	ExtractionHandler["settleInTransaction"]
>[3];

/** A queue that only remembers the jobs scheduled for it (state is set by the driver). */
export function fakeQueue() {
	const jobs = new Map<
		string,
		{
			id: string;
			kind: string;
			payload: unknown;
			state: string;
			resourceKey?: string | null;
			lane: string;
			maxAttempts?: number;
		}
	>();
	let n = 0;
	const queue: ExtractionQueue = {
		enqueueInTransaction(_tx, input) {
			n += 1;
			const id = `job-${n}`;
			jobs.set(id, {
				id,
				kind: input.kind,
				payload: input.payload,
				state: "queued",
				resourceKey: input.resourceKey ?? null,
				lane: input.lane,
				...(input.maxAttempts === undefined
					? {}
					: { maxAttempts: input.maxAttempts }),
			});
			return { job: { id }, fresh: true };
		},
		getInTransaction(_tx, id) {
			const job = jobs.get(id);
			return job ? { state: job.state } : null;
		},
	};
	return { queue, jobs };
}

export type Call = {
	requestId: string;
	messages: { role: string; content: string }[];
	signal: AbortSignal;
};
export type FakeInferenceState = {
	captured: string[];
	executed: number;
	accepted: number;
	rejected: string[];
	cancelled: string[];
	/** Everything the model was shown, one entry per call. */
	prompts: string[];
	/** Cloud requests recorded. The fake has no Cloud path: always 0. */
	cloudRequests: number;
};

/** A Local-only inference slice; `script` produces the model text (or throws / waits). */
export function fakeInference(
	script: (call: Call) => Promise<string> | string,
	over: Partial<ExtractionInference> = {},
) {
	const state: FakeInferenceState = {
		captured: [],
		executed: 0,
		accepted: 0,
		rejected: [],
		cancelled: [],
		prompts: [],
		cloudRequests: 0,
	};
	const subjects = new Map<string, string>();
	const port: ExtractionInference = {
		captureMaintenanceControlInTransaction(_db, input) {
			const id = `req-${state.captured.length + 1}`;
			state.captured.push(id);
			subjects.set(input.subject, id);
			return id;
		},
		async executeControl(requestId, messages, signal) {
			state.executed += 1;
			state.prompts.push(JSON.stringify(messages));
			const value = await script({ requestId, messages, signal });
			return { requestId, attemptId: `att-${state.executed}`, value };
		},
		acceptInTransaction() {
			state.accepted += 1;
			return true;
		},
		rejectControlInTransaction(_db, _receipt, code) {
			state.rejected.push(code);
		},
		cancelRequestsInTransaction(_db, ids) {
			state.cancelled.push(...ids);
		},
		snapshotFor() {
			return { routes: { llm: { mode: "larm-only", cloudAllowed: false } } };
		},
		...over,
	};
	return { port, state };
}

export const SERVICE_ENTITY = {
	id: "svc-1",
	scope: SCOPE,
	revision: 1,
	displayName: "音声サービス",
	aliases: ["音声"],
	externalRefs: [],
};

/** One valid candidate quoting the first `words` characters of `text`. */
export function candidate(
	text: string,
	eventId: string,
	over: Record<string, unknown> = {},
	words = 6,
) {
	const quoted = [...text].slice(0, words).join("");
	const bytes = new TextEncoder().encode(quoted).length;
	return {
		subject: { kind: "id", id: "svc-1" },
		predicate: "available",
		payload: { kind: "value", value: { kind: "boolean", value: true } },
		quote: { utteranceId: eventId, startByte: 0, endByte: bytes },
		modality: "asserted",
		...over,
	};
}

export type Rig = {
	life: Life;
	extraction: WorldExtraction;
	jobs: ReturnType<typeof fakeQueue>["jobs"];
	inference: ReturnType<typeof fakeInference>;
	reports: unknown[];
};

/** Extraction wired to a Life with a fake queue and a fake Local inference. */
export function rigFor(
	life: Life,
	script: (call: Call) => Promise<string> | string,
	over: Partial<ExtractionOptions> = {},
	inferenceOver: Partial<ExtractionInference> = {},
): Rig {
	const { queue, jobs } = fakeQueue();
	const inference = fakeInference(script, inferenceOver);
	const reports: unknown[] = [];
	const extraction = createWorldExtraction({
		store: life.store,
		world: life.world,
		sources: [
			createConversationSourceAdapter(life.conversation, {
				allowedPurposes: [PURPOSE],
				cursorSecret: TEST_CURSOR_SECRET,
			}),
		],
		queue,
		inference: inference.port,
		gate: life.gate,
		purpose: PURPOSE,
		entities: () => [SERVICE_ENTITY],
		clock: () => 1791500000000,
		stageBudgetMs: 60,
		confirmMs: 40,
		onReport: (report) => reports.push(report),
		...over,
	});
	return { life, extraction, jobs, inference, reports };
}

export type JobRun = {
	prepared:
		| { status: "ready"; input: PreparedExtraction }
		| { status: "stale"; reason: string };
	outcome?: SettleOutcomeOf;
	settle?: unknown;
};

/** Plays the queue: claim -> prepare -> execute -> settle, each in its own writer callback. */
export async function runJob(
	rig: Rig,
	jobId: string,
	options: { signal?: AbortSignal; attempt?: number } = {},
): Promise<JobRun> {
	const job = rig.jobs.get(jobId)!;
	job.state = "running";
	const claim = {
		jobId,
		scope: "world",
		kind: job.kind,
		payloadVersion: 1,
		payload: job.payload as never,
		subjectRef: null,
		owner: "owner-1",
		attempt: options.attempt ?? 1,
		generation: 0,
		maxAttempts: 2,
		deadlineAtMs: null,
	};
	const handler = rig.extraction.handler;
	const prepared = await rig.life.store.write((db: Database) =>
		handler.prepareInTransaction(db, claim),
	);
	if (prepared.status === "stale") {
		job.state = "cancelled";
		return { prepared };
	}
	let outcome: SettleOutcomeOf;
	try {
		const result = await handler.execute(prepared.input, {
			signal: options.signal ?? new AbortController().signal,
			jobId,
			attempt: claim.attempt,
			generation: 0,
		});
		outcome = { type: "success", result };
	} catch (error) {
		const code = error instanceof Error ? error.message : "execution_failed";
		outcome =
			handler.classify(error) === "retry" && claim.attempt < claim.maxAttempts
				? { type: "retry", errorCode: code, availableAtMs: 0 }
				: { type: "failed", errorCode: code };
	}
	const settle = await rig.life.store.write((db: Database) =>
		handler.settleInTransaction(db, claim, prepared.input, outcome),
	);
	job.state =
		outcome.type === "success"
			? "completed"
			: outcome.type === "retry"
				? "retry_wait"
				: "failed";
	return { prepared, outcome, settle };
}

/** Schedules and runs jobs until nothing is left to schedule; returns the job ids run. */
export async function drain(rig: Rig, max = 10): Promise<string[]> {
	const ran: string[] = [];
	for (let i = 0; i < max; i++) {
		const scheduled = await rig.extraction.schedule(SCOPE);
		if (scheduled.status !== "scheduled") break;
		await runJob(rig, scheduled.jobId);
		ran.push(scheduled.jobId);
	}
	return ran;
}

export const modelOutput = (...candidates: unknown[]) =>
	JSON.stringify({ candidates });

export const inboxRows = (life: Life) =>
	life.store.read((db) =>
		db
			.query(
				"SELECT event_id, feed_key, seq, status FROM world_inbox ORDER BY seq, event_id",
			)
			.all(),
	) as { event_id: string; feed_key: string; seq: number; status: string }[];

export const checkpointRows = (life: Life) =>
	life.store.read((db) =>
		db
			.query(
				"SELECT feed_key, received_cursor, applied_cursor FROM world_checkpoint ORDER BY feed_key",
			)
			.all(),
	) as {
		feed_key: string;
		received_cursor: string | null;
		applied_cursor: string | null;
	}[];

export const mirrorRows = (life: Life) =>
	life.store.read((db) =>
		db
			.query(
				"SELECT event_id, seq, state, reason, failures, retry_at_ms, job_id, manifest_id, request_id, received_cursor FROM world_host_extract_event ORDER BY seq",
			)
			.all(),
	) as {
		event_id: string;
		seq: number;
		state: string;
		reason: string | null;
		failures: number;
		retry_at_ms: number;
		job_id: string | null;
		manifest_id: string | null;
		request_id: string | null;
		received_cursor: string;
	}[];

export const assertionRows = (life: Life) =>
	life.store.read((db) =>
		db
			.query(
				"SELECT id, revision, lifecycle, origin FROM world_assertion ORDER BY id, revision",
			)
			.all(),
	) as { id: string; revision: number; lifecycle: string; origin: string }[];
