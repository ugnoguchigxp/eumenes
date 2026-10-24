import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrations as memoryPackageMigrations } from "eumenes-memory/sqlite";
import { configureLogging } from "../../../infrastructure/logger";
import { openStore, type SqliteStore } from "../../../infrastructure/sqlite";
import {
	CONVERSATION_DEFAULT_PRINCIPAL,
	CONVERSATION_DEFAULT_SCOPE,
	createConversationService,
	migrations as conversationMigrations,
	type ConversationService,
} from "../../conversation";
import { createGoalsService, migrations as goalsMigrations } from "../../goals";
import {
	createContinuityService,
	migrations as continuityMigrations,
} from "../../continuity";
import {
	createMemoryService,
	migrations as memoryMigrations,
	type MemoryEmbed,
	type MemoryService,
} from "../../memory";
import type { WindowPlan } from "../../../infrastructure/context-budget";
import { createQueue, migrations as queueMigrations } from "../../queue";
import type {
	ChatMessage,
	ControlReceipt,
	InferencePort,
	RunEnd,
	RunLookup,
} from "../contracts";
import { migrations as stewardMigrations } from "../repository";
import { createStewardService } from "../service";
import { steps } from "../service/steps";
import type { StewardDeps, StewardWorld } from "../service/types";

export const migrations = [
	...conversationMigrations,
	...continuityMigrations,
	...memoryMigrations,
	...memoryPackageMigrations,
	...queueMigrations,
	...goalsMigrations,
	...stewardMigrations,
];

/** The goals of the conversation (the Scope World and the Broker use too). */
export const GOALS_ACCESS = {
	principal: CONVERSATION_DEFAULT_PRINCIPAL,
	scopeKeys: [CONVERSATION_DEFAULT_SCOPE],
} as const;

/** What the scripted model answers for one call: an object (sent as JSON), a raw string, or an error to throw. */
export type Scripted =
	| Record<string, unknown>
	| string
	| Error
	| ((data: Record<string, unknown>) => Scripted | Promise<Scripted>);
export type ModelCall = {
	step: string;
	requestId: string;
	data: Record<string, unknown>;
	/** The output schema the request was made with. */
	schema: unknown;
};

/** A scripted stand-in for the inference service: it answers by step id, records the calls and tracks the requests. */
export function createFakeInference() {
	const scripts = new Map<string, Scripted[]>();
	const calls: ModelCall[] = [];
	/** What each request capture was asked for. */
	const captures: Array<
		Parameters<InferencePort["captureBackgroundControlInTransaction"]>[1]
	> = [];
	const requests = new Map<
		string,
		"pending" | "accepted" | "rejected" | "cancelled"
	>();
	let counter = 0;
	const state = { unavailable: false };
	/** Steps a test does not care about answer "nothing" unless scripted. */
	const defaults: Record<string, Scripted> = {
		"prepare-recall": { query: null },
	};
	const stepOf = (messages: ChatMessage[]) =>
		Object.values(steps).find((step) =>
			messages[0]?.content.startsWith(step.instructions),
		)?.id ?? "unknown";
	const port: InferencePort = {
		captureBackgroundControlInTransaction(_db, input) {
			captures.push(input);
			if (state.unavailable)
				throw new Error("background_inference_unavailable");
			const id = `req-${++counter}`;
			requests.set(id, "pending");
			return id;
		},
		async executeControl(
			requestId,
			messages,
			_signal,
			control,
		): Promise<ControlReceipt> {
			const step = stepOf(messages);
			const data = JSON.parse(messages[1]!.content) as Record<string, unknown>;
			calls.push({ step, requestId, data, schema: control?.outputSchema });
			const queue = scripts.get(step);
			let answer = queue?.shift() ?? defaults[step];
			if (answer === undefined) throw new Error("no_script");
			while (typeof answer === "function") answer = await answer(data);
			if (answer instanceof Error) throw answer;
			return {
				requestId,
				attemptId: `attempt-${calls.length}`,
				value: typeof answer === "string" ? answer : JSON.stringify(answer),
			};
		},
		acceptInTransaction(_db, receipt) {
			if (requests.get(receipt.requestId) !== "pending") return false;
			requests.set(receipt.requestId, "accepted");
			return true;
		},
		rejectControlInTransaction(_db, receipt) {
			requests.set(receipt.requestId, "rejected");
		},
		cancelRequestsInTransaction(_db, ids) {
			for (const id of ids)
				if (requests.get(id) === "pending") requests.set(id, "cancelled");
		},
		flushCancelledRequests() {},
		countControlTokens: (messages) => messages[0]?.content.length ?? 0,
	};
	return {
		port,
		calls,
		captures,
		requests,
		state,
		/** The next calls of this step are answered in order. */
		script(step: string, ...answers: Scripted[]) {
			scripts.set(step, [...(scripts.get(step) ?? []), ...answers]);
		},
		callsOf: (step: string) => calls.filter((call) => call.step === step),
		statuses: (status: string) =>
			[...requests.values()].filter((value) => value === status).length,
	};
}
export type FakeInference = ReturnType<typeof createFakeInference>;

export async function setupSteward(
	options: {
		embed?: MemoryEmbed;
		/** The window plan of the saved model; absent: the reference window's. */
		windowPlan?: () => WindowPlan;
		runStates?: Record<string, RunLookup>;
		/** Replaces the memory service the steward is given (a test makes one operation refuse). */
		wrapMemory?: (memory: MemoryService) => MemoryService;
		/** The steward maintains goals (the real goals service on the same database). */
		goals?: boolean;
		/** The saved resource the World curation runs on. */
		worldResourceId?: string;
		/** The World the steward curates: built once the store and the conversation exist. */
		world?: (parts: {
			store: SqliteStore;
			conversation: ConversationService;
			memory: MemoryService;
			/** Kicks the steward (the World's notice that events arrived). */
			kick(conversationId: string): Promise<void>;
		}) => StewardWorld | Promise<StewardWorld>;
		/** A database and conversation service made elsewhere (the real World's); `dir` is its folder. */
		host?: {
			store: SqliteStore;
			conversation: ConversationService;
			dir: string;
			close(): Promise<void>;
		};
	} = {},
) {
	configureLogging({ level: "silent" });
	const dir =
		options.host?.dir ?? mkdtempSync(join(tmpdir(), "eumenes-steward-"));
	const store: SqliteStore =
		options.host?.store ?? openStore(join(dir, "db.sqlite3"), migrations);
	const time = { ms: Date.parse("2026-10-14T12:00:00.000Z") };
	const clock = () => new Date(time.ms).toISOString();
	let counter = 0;
	const conversation =
		options.host?.conversation ?? createConversationService(store);
	const continuity = createContinuityService(store, clock);
	const memory = createMemoryService(store, conversation, continuity, {
		journalPath: join(dir, "journal.jsonl"),
		clock,
		id: () => `id-${++counter}`,
		...(options.embed ? { embed: () => options.embed } : {}),
		...(options.windowPlan ? { windowPlan: options.windowPlan } : {}),
	});
	if (!(await memory.recover()).healthy) throw new Error("memory_not_healthy");
	const queue = createQueue(store, {
		now: () => time.ms,
		id: () => crypto.randomUUID(),
		sleep: () => new Promise(() => {}),
		random: () => 0,
		backoff: { baseMs: 1000, maxMs: 30_000 },
	});
	const inference = createFakeInference();
	const foreground = new Set<string>();
	/** The steward's wake timer, driven by the test clock. */
	const timers: Array<{ at: number; run: () => void; live: boolean }> = [];
	const runStates: Record<string, RunLookup> = options.runStates ?? {};
	const goals = options.goals ? createGoalsService(store, clock) : undefined;
	const kickLate = async (conversationId: string) => {
		await store.write((db) => steward.kickInTransaction(db, conversationId));
	};
	const world = options.world
		? await options.world({ store, conversation, memory, kick: kickLate })
		: undefined;
	const steward = createStewardService({
		store,
		memory: options.wrapMemory ? options.wrapMemory(memory) : memory,
		conversation,
		continuity,
		queue,
		inference: inference.port,
		foregroundActive: (_db, conversationId) => foreground.has(conversationId),
		runStateOf: (runId) => runStates[runId] ?? "stale",
		clock,
		nowMs: () => time.ms,
		newId: () => crypto.randomUUID(),
		setTimer(run, ms) {
			const timer = { at: time.ms + ms, run, live: true };
			timers.push(timer);
			return () => {
				timer.live = false;
			};
		},
		...(world ? { world } : {}),
		...(goals ? { goals: { ops: goals, access: GOALS_ACCESS } } : {}),
		worldResourceId: () => options.worldResourceId ?? null,
	} satisfies StewardDeps);
	queue.registerHandler(steward.handler as never);
	let messages = 0;
	const yieldTurn = () => new Promise((resolve) => setImmediate(resolve));
	const harness = {
		dir,
		store,
		time,
		conversation,
		continuity,
		memory,
		goals,
		queue,
		steward,
		inference,
		foreground,
		runStates,
		timers,
		/** The times the steward's timer waits for. */
		timerTimes: () => timers.filter((t) => t.live).map((t) => t.at),
		/** Moves the clock to the earliest timer and runs it; false when none waits. */
		async fireTimer() {
			const next = timers.filter((t) => t.live).sort((a, b) => a.at - b.at)[0];
			if (!next) return false;
			next.live = false;
			if (next.at > time.ms) time.ms = next.at;
			next.run();
			for (let j = 0; j < 20; j++) await yieldTurn();
			return true;
		},
		/** Runs the queue a few times without moving the clock or the timer. */
		async pump(times = 12) {
			for (let i = 0; i < times; i++) {
				await queue.tick();
				for (let j = 0; j < 20; j++) await yieldTurn();
			}
		},
		/** Queue jobs that wait for a later time (the steward never enqueues one). */
		futureJobs: () =>
			store.read((db) =>
				db
					.query(
						"SELECT id FROM queue_jobs WHERE state IN ('queued','retry_wait') AND available_at_ms > ?",
					)
					.all(time.ms),
			),
		async say(
			role: "user" | "assistant",
			text: string,
			conversationId = "c1",
			runId?: string,
		) {
			const id = `msg-${++messages}`;
			await conversation.append({
				id,
				conversationId,
				role,
				text,
				createdAt: clock(),
				runId: runId ?? (role === "user" ? `run-${id}` : null),
			});
			return id;
		},
		/**
		 * What the dialogue records for a run: the user's utterance (handled, in the log) and the adopted answer, as
		 * `said` events that show their messages, then the run's end (the steward's kick), in one transaction.
		 */
		async exchange(
			user: string,
			answer: string | null,
			options: { conversationId?: string; runId?: string } = {},
		) {
			const conversationId = options.conversationId ?? "c1";
			const runId = options.runId ?? `run-${messages + 1}`;
			const inputMessageId = await harness.say(
				"user",
				user,
				conversationId,
				runId,
			);
			const answerMessageId =
				answer === null
					? null
					: await harness.say("assistant", answer, conversationId, runId);
			const seqs = await store.write((db) => {
				const seqs = harness.recordSaid(
					db,
					conversationId,
					inputMessageId,
					answerMessageId,
					{ user, agent: answer ?? undefined },
				);
				steward.runEndedInTransaction(db, {
					runId,
					conversationId,
					state: answerMessageId === null ? "failed" : "completed",
				});
				return seqs;
			});
			return { inputMessageId, answerMessageId, runId, ...seqs };
		},
		/** The `said` events of a run's messages (the user's, handled; the answer's). */
		recordSaid(
			db: Database,
			conversationId: string,
			inputMessageId: string,
			answerMessageId: string | null,
			texts: { user?: string; agent?: string } = {},
		) {
			const user = continuity.events.appendInTransaction(db, {
				conversationId,
				at: clock(),
				type: "said",
				by: "user",
				fields: { text: texts.user ?? "user" },
				messageIds: [inputMessageId],
			}).event;
			const agent =
				answerMessageId === null
					? null
					: continuity.events.appendInTransaction(db, {
							conversationId,
							at: clock(),
							type: "said",
							by: "agent",
							fields: { origin: "reply", text: texts.agent ?? "agent" },
							messageIds: [answerMessageId],
						}).event;
			return { userSeq: user.seq, agentSeq: agent?.seq ?? null };
		},
		/**
		 * A run as the dialogue ends it: the user message, requests the conversation agent committed, and how it
		 * ended. `completed` adopts an answer; `failed` and `interrupted` leave only the user's event; `cancelled`
		 * and `stale` record no event. The requests are queued when committed, whatever way the run ended.
		 */
		async run(input: {
			user: string;
			answer?: string;
			end: RunEnd;
			requests?: Array<{
				kind: "forget" | "remember" | "correct" | "goal" | "withdraw";
				what: string;
				detail?: string;
			}>;
			conversationId?: string;
		}) {
			const conversationId = input.conversationId ?? "c1";
			const runId = `run-${messages + 1}`;
			const inputMessageId = await harness.say(
				"user",
				input.user,
				conversationId,
				runId,
			);
			const answerMessageId =
				input.end === "completed"
					? await harness.say(
							"assistant",
							input.answer ?? "了解",
							conversationId,
							runId,
						)
					: null;
			const requestIds: string[] = [];
			await store.write((db) => {
				(input.requests ?? []).forEach((request, i) => {
					const requestId = `${runId}-req-${i + 1}`;
					requestIds.push(requestId);
					steward.requestInTransaction(db, {
						requestId,
						conversationId,
						sourceRef: inputMessageId,
						...request,
					});
				});
			});
			await store.write((db) => {
				if (
					input.end === "completed" ||
					input.end === "failed" ||
					input.end === "interrupted"
				)
					harness.recordSaid(
						db,
						conversationId,
						inputMessageId,
						answerMessageId,
					);
				steward.runEndedInTransaction(db, {
					runId,
					conversationId,
					state: input.end,
				});
			});
			return { inputMessageId, answerMessageId, runId, requestIds };
		},
		/** An exchange the steward already handled, written straight into the log as handled events. */
		async settledExchange(user: string, answer: string, conversationId = "c1") {
			const runId = `run-${messages + 1}`;
			const inputMessageId = await harness.say(
				"user",
				user,
				conversationId,
				runId,
			);
			const answerMessageId = await harness.say(
				"assistant",
				answer,
				conversationId,
				runId,
			);
			await store.write((db) => {
				const seqs = harness.recordSaid(
					db,
					conversationId,
					inputMessageId,
					answerMessageId,
				);
				continuity.events.markCuratedInTransaction(db, conversationId, [
					seqs.userSeq,
					seqs.agentSeq!,
				]);
			});
			return { inputMessageId, answerMessageId };
		},
		/** The log of a conversation, in log order. */
		log: (conversationId = "c1") =>
			store.read((db) =>
				continuity.events.logInTransaction(db, conversationId),
			),
		/** The episode of a conversation (the shown or the prepared one). */
		episode: (stage: "shown" | "prepared", conversationId = "c1") =>
			store.read((db) =>
				continuity.events.episodeInTransaction(db, conversationId, stage),
			),
		state: (conversationId = "c1") =>
			store.read(
				(db) =>
					db
						.query(
							"SELECT maintenance_revision AS revision, maintained_revision AS maintained, quiet_steps AS quiet, next_maintenance_at AS nextAt, defer_count AS deferCount FROM steward_state WHERE conversation_id = ?",
						)
						.get(conversationId) as {
						revision: number;
						maintained: number;
						quiet: string;
						nextAt: number | null;
						deferCount: number;
					} | null,
			),
		runEnded: (runId: string, conversationId: string, state: RunEnd) =>
			store.write((db) =>
				steward.runEndedInTransaction(db, { runId, conversationId, state }),
			),
		kick: (conversationId?: string) =>
			store.write((db) => steward.kickInTransaction(db, conversationId)),
		/** Runs the queue until no steward job is open (advancing the clock for jobs that wait). */
		async drain(limit = 200) {
			for (let i = 0; i < limit; i++) {
				await queue.tick();
				for (let j = 0; j < 20; j++) await yieldTurn();
				const open = store.read(
					(db) =>
						(
							db
								.query(
									"SELECT COUNT(*) AS n FROM queue_jobs WHERE state IN ('queued','running','retry_wait','cancel_requested')",
								)
								.get() as { n: number }
						).n,
				);
				if (open === 0) {
					// Waiting without a job (a failed target's retry, a deferred upkeep): the timer kicks again.
					if (await harness.fireTimer()) continue;
					return;
				}
				const next = store.read(
					(db) =>
						(
							db
								.query(
									"SELECT MIN(available_at_ms) AS t FROM queue_jobs WHERE state IN ('queued','retry_wait')",
								)
								.get() as { t: number | null }
						).t,
				);
				if (next !== null && next > time.ms) time.ms = next;
			}
			throw new Error("steward_not_idle");
		},
		units: () =>
			store.read(
				(db) =>
					db
						.query(
							"SELECT id, conversation_id AS conversationId, step, kind, state, slot, targets, attempt FROM steward_unit ORDER BY rowid",
						)
						.all() as Array<{
						id: string;
						conversationId: string;
						step: string;
						kind: string;
						state: string;
						slot: string;
						targets: string;
						attempt: number;
					}>,
			),
		inbox: () =>
			store.read(
				(db) =>
					db
						.query(
							"SELECT id, kind, what, detail, state, result_code AS resultCode, failures FROM steward_inbox ORDER BY created_at, id",
						)
						.all() as Array<{
						id: string;
						kind: string;
						what: string;
						detail: string | null;
						state: string;
						resultCode: string | null;
						failures: number;
					}>,
			),
		async close() {
			if (options.host) return options.host.close();
			await store.close().catch(() => {});
			rmSync(dir, { recursive: true, force: true });
		},
	};
	return harness;
}
export type StewardHarness = Awaited<ReturnType<typeof setupSteward>>;

/** The whole reflecting pipeline answered with "nothing to save, keep everything". */
export function quietReflect(h: StewardHarness) {
	h.inference.script("curate-memory", {
		remember: [],
		update: [],
		stop: [],
		notes: [],
		resolve: [],
	});
}

/** Texts that mention a topic share a vector: enough for the recall to find "the earlier talk about it". */
export const topicEmbed: MemoryEmbed = async (texts) => ({
	vectors: texts.map((text) =>
		text.includes("住所")
			? [1, 0, 0]
			: text.includes("辛い")
				? [0, 1, 0]
				: [0, 0, 1],
	),
	space: { modelId: "test", revision: "1", artifactDigest: "d", dimension: 3 },
});
