import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrations as memoryPackageMigrations } from "eumenes-memory/sqlite";
import { configureLogging } from "../../../infrastructure/logger";
import { openStore, type SqliteStore } from "../../../infrastructure/sqlite";
import {
	migration as conversationMigration,
	avatarMotionMigration,
	answerDeliveryMigration,
	createConversationService,
} from "../../conversation";
import {
	createContinuityService,
	migration as continuityMigration,
	shortTermMigration,
} from "../../continuity";
import { createQueue, migration as queueMigration } from "../../queue";
import {
	contextWindowMigration,
	agentHardeningMigration,
	turnVectorsMigration,
	createMemoryService,
	migration,
	type AgentInferencePort,
	type MemoryEmbed,
} from "../../memory";

export const MIGRATIONS = [
	conversationMigration,
	avatarMotionMigration,
	answerDeliveryMigration,
	continuityMigration,
	shortTermMigration,
	migration,
	contextWindowMigration,
	agentHardeningMigration,
	turnVectorsMigration,
	queueMigration,
	...memoryPackageMigrations,
];

/** What the agent sent the model: the JSON of the user message. */
export type AgentData = {
	today: string;
	turns: Array<{
		label: string;
		role: string;
		text: string;
		createdAt: string;
	}>;
	longTerm: Array<{ ref: string; kind: string; text: string }>;
	shortTerm: Array<{ ref: string; kind: string; text: string }>;
	budgets: Record<string, number>;
};

/** A scripted auxiliary inference: records every call and answers with whatever the test says. */
export function fakeInference() {
	const state = {
		requests: 0,
		captured: [] as Array<Record<string, number | string>>,
		calls: [] as Array<{ requestId: string; data: AgentData; system: string }>,
		rejected: [] as string[],
		cancelled: [] as string[],
		flushed: [] as string[],
		accept: true,
		unavailable: false,
		/** Held back until the test opens it (execution in flight). */
		gate: undefined as Promise<void> | undefined,
		script: (_data: AgentData, _requestId: string): string | Promise<string> =>
			'{"ops":[]}',
	};
	const port: AgentInferencePort = {
		captureBackgroundControlInTransaction(_db, input) {
			if (state.unavailable) throw new Error("llm_unavailable");
			state.captured.push({ ...input });
			return `req-${++state.requests}`;
		},
		async executeControl(requestId, messages, signal) {
			state.calls.push({
				requestId,
				data: JSON.parse(messages[1]?.content ?? "{}") as AgentData,
				system: messages[0]?.content ?? "",
			});
			if (state.gate) await state.gate;
			signal.throwIfAborted();
			const call = state.calls[state.calls.length - 1] as { data: AgentData };
			return {
				requestId,
				attemptId: "attempt",
				value: await state.script(call.data, requestId),
			};
		},
		acceptInTransaction: () => state.accept,
		rejectControlInTransaction(_db, _receipt, code) {
			state.rejected.push(code);
		},
		cancelRequestsInTransaction(_db, ids) {
			state.cancelled.push(...ids);
		},
		flushCancelledRequests(ids) {
			state.flushed.push(...ids);
		},
	};
	return { state, port };
}
export type FakeInference = ReturnType<typeof fakeInference>;

export const pause = (ms: number) =>
	new Promise((resolve) => setTimeout(resolve, ms));
export async function until(check: () => boolean, what = "condition") {
	for (let i = 0; i < 500; i++) {
		if (check()) return;
		await pause(10);
	}
	throw new Error(`timeout: ${what}`);
}

/** A memory service with the real queue and a scripted inference. */
export async function setupAgent(
	options: {
		inference?: boolean;
		clock?: string;
		queueLimits?: { total: number; background: number; scope: number };
		/** The embedding the agent is given (none: no vectors are made). */
		embed?: MemoryEmbed;
	} = {},
) {
	configureLogging({ level: "silent" });
	const dir = mkdtempSync(join(tmpdir(), "eumenes-memory-agent-"));
	const store: SqliteStore = openStore(join(dir, "db.sqlite3"), MIGRATIONS);
	const time = { now: options.clock ?? "2026-10-13T12:00:00.000Z" };
	const clock = () => time.now;
	let counter = 0;
	const conversation = createConversationService(store);
	const continuity = createContinuityService(store, clock);
	const queue = createQueue(store, {
		resources: { "inference.llm": 1, "inference.aux": 2 },
		...(options.queueLimits ? { limits: options.queueLimits } : {}),
	});
	const inference = fakeInference();
	const memory = createMemoryService(store, conversation, continuity, {
		journalPath: join(dir, "journal.jsonl"),
		clock,
		id: () => `id-${++counter}`,
		queue,
		...(options.inference === false ? {} : { inference: inference.port }),
		...(options.embed ? { embed: () => options.embed } : {}),
	});
	queue.registerHandler(memory.agentHandler());
	expectHealthy(await memory.recover());
	queue.start();
	let messages = 0;
	const harness = {
		dir,
		store,
		time,
		conversation,
		continuity,
		memory,
		queue,
		inference,
		/** Adds a message of the conversation; user messages get a run id of their own. */
		async say(
			role: "user" | "assistant",
			text: string,
			conversationId = "c1",
			runId?: string,
		) {
			const id = `m${++messages}`;
			await conversation.append({
				id,
				conversationId,
				role,
				text,
				createdAt: time.now,
				runId: runId ?? (role === "user" ? `run-${id}` : null),
			});
			return id;
		},
		/** What intake or adoption does in the same transaction as the message. */
		async schedule(conversationId = "c1") {
			await store.write((db) =>
				memory.scheduleAgentInTransaction(db, conversationId),
			);
			queue.wake();
		},
		jobs: () => queue.list({ scope: "memory" }).items,
		/** Every queued memory job has finished. */
		async settled(minJobs = 1) {
			await until(() => {
				const jobs = queue.list({ scope: "memory" }).items;
				return (
					jobs.length >= minJobs &&
					jobs.every((job) =>
						[
							"completed",
							"failed",
							"cancelled",
							"expired",
							"interrupted",
						].includes(job.state),
					)
				);
			}, "memory jobs settled");
		},
		cursor: (conversationId = "c1") =>
			store.read(
				(db) =>
					(
						db
							.query(
								"SELECT last_ordinal AS n FROM memory_agent_cursor WHERE conversation_id = ?",
							)
							.get(conversationId) as { n: number } | null
					)?.n ?? null,
			),
		/** The acceptance-order ordinal of a message. */
		ordinal: (messageId: string) =>
			store.read(
				(db) => conversation.messageInTransaction(db, messageId)?.ordinal ?? 0,
			),
		/** Starts the conversation's reading at a given ordinal (an existing history the agent is to treat as read or unread). */
		async setCursor(ordinal: number, conversationId = "c1") {
			await store.write((db) =>
				db
					.query(
						"INSERT OR REPLACE INTO memory_agent_cursor (conversation_id, last_ordinal, failures) VALUES (?,?,0)",
					)
					.run(conversationId, ordinal),
			);
		},
		failures: (conversationId = "c1") =>
			store.read(
				(db) =>
					(
						db
							.query(
								"SELECT failures AS n FROM memory_agent_cursor WHERE conversation_id = ?",
							)
							.get(conversationId) as { n: number } | null
					)?.n ?? null,
			),
		/** The control requests the agent still holds for jobs in flight. */
		heldRequests: () =>
			store.read(
				(db) =>
					db
						.query(
							"SELECT job_id AS jobId, request_id AS requestId FROM memory_agent_request",
						)
						.all() as Array<{
						jobId: string;
						requestId: string;
					}>,
			),
		window: (conversationId = "c1") =>
			store.write((db) => {
				const window = memory.windowForRunInTransaction(db, conversationId);
				if (!window) throw new Error("memory off");
				return window;
			}),
		/** Registers State through the API (a user-confirmed item with no provenance). */
		async seed(
			text: string,
			semanticKey: string,
			quote = text,
			kind: "preference" | "habit" = "preference",
		) {
			const messageId = await harness.say("user", `${text}。`, "seed");
			return memory.remember({
				conversationId: "seed",
				messageId,
				quote,
				kind,
				semanticKey,
				text,
				polarity: "affirmed",
			});
		},
		async close() {
			await queue.close(100).catch(() => {});
			await store.close().catch(() => {});
			rmSync(dir, { recursive: true, force: true });
		},
	};
	return harness;
}
export type AgentHarness = Awaited<ReturnType<typeof setupAgent>>;
function expectHealthy(recovery: { healthy: boolean }) {
	if (!recovery.healthy) throw new Error("memory_not_healthy");
}
