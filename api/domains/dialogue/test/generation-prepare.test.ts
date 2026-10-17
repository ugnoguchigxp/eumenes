/**
 * The session split of a generation (instructionCount) must match the messages actually sent. A failed
 * research result leaves the long-term and goals layers out, so the count follows the assembled list.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrations as memoryPackageMigrations } from "eumenes-memory/sqlite";
import { openStore, type SqliteStore } from "../../../infrastructure/sqlite";
import { RESEARCH_FAILURE_REPLY } from "../service/research-failure-reply";
import { waitFor as until } from "../../../infrastructure/wait-for";
import type { AgentRuntime, AnswerTicket } from "../../agent-runtime";
import {
	migrations as conversationMigrations,
	createConversationService,
} from "../../conversation";
import {
	createContinuityService,
	migration as continuityMigration,
	shortTermMigration,
	itemSourceMigration,
} from "../../continuity";
import type { CallSession } from "../../inference";
import type { LarmPort } from "../../larm";
import {
	createMemoryService,
	migration as memoryMigration,
	contextWindowMigration,
	agentHardeningMigration,
	turnVectorsMigration,
	stewardLedgersMigration,
	forgetClosureMigration,
	seedImportMigration,
} from "../../memory";
import { createQueue, migration as queueMigration } from "../../queue";
import {
	createDialogueService,
	agentLinkMigration,
	migration as dialogueMigration,
	queueLinkMigration,
	worldStateMigration,
} from "..";
import { saveItem } from "./memory-seed";

const MIGRATIONS = [
	...conversationMigrations,
	dialogueMigration,
	queueMigration,
	queueLinkMigration,
	agentLinkMigration,
	worldStateMigration,
	continuityMigration,
	shortTermMigration,
	itemSourceMigration,
	memoryMigration,
	contextWindowMigration,
	agentHardeningMigration,
	turnVectorsMigration,
	stewardLedgersMigration,
	forgetClosureMigration,
	seedImportMigration,
	...memoryPackageMigrations,
];
type Sent = Array<{ role: string; content: string }>;
const dirs: string[] = [];
const stores: SqliteStore[] = [];
afterEach(async () => {
	for (const s of stores.splice(0)) await s.close().catch(() => {});
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A run of the main conversation with a long-term fact and an adopted goal, optionally answering a failed research. */
async function generate(failureCode: string | null) {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-generation-prepare-"));
	dirs.push(dir);
	const store = openStore(join(dir, "db.sqlite3"), MIGRATIONS);
	stores.push(store);
	const sessions: Array<CallSession | undefined> = [];
	const seen: Sent[] = [];
	const larm = {
		status: () => ({ state: "ready", capabilities: ["llm"] }),
		connect: async () => {},
		requestFor: () => "request-1",
		executeRequest: async (
			_id: string,
			messages: Sent,
			_signal: AbortSignal,
			_preparation: unknown,
			session?: CallSession,
		) => {
			sessions.push(session);
			seen.push(messages.map((m) => ({ ...m })));
			return {
				requestId: "request-1",
				attemptId: "attempt",
				value: "了解です",
			};
		},
		acceptInTransaction: () => true,
		answer: async () => "了解です",
		transcribe: async () => "",
		speak: async () => new Uint8Array(),
		close: async () => {},
	} as unknown as LarmPort;
	const conversation = createConversationService(store);
	const continuity = createContinuityService(store);
	const memory = createMemoryService(store, conversation, continuity, {
		journalPath: join(dir, "journal.jsonl"),
	});
	await memory.recover();
	const goals = {
		adoptedForContextInTransaction: () => [
			{
				goalId: "g1",
				priority: 1,
				desiredState: "毎日少し運動する",
				revision: 1,
			},
		],
		existingInTransaction: () => new Set(["g1"]),
	};
	const ticket: AnswerTicket = {
		taskId: "t",
		eventId: "event-1",
		revision: 1,
		dataEpoch: 0,
		reportTaskId: "c",
		reportEpoch: 3,
		reportDigest: null,
		projection: null,
		failureCode,
	};
	const agents = {
		startInTransaction: () => ({ taskId: "t", jobId: "unused" }),
		prepareAnswerInTransaction: () => ticket,
		completeAnswerInTransaction: () => {},
		validAnswerInTransaction: () => true,
		failAnswerInTransaction: () => {},
		pendingEvents: () => [],
		byRootInTransaction: () => null,
	} as unknown as AgentRuntime;
	const open = () => {
		const queue = createQueue(store);
		const dialogue = createDialogueService({
			store,
			conversation,
			larm,
			queue,
			memory,
			goals,
			...(failureCode ? { agents } : {}),
		});
		return { queue, dialogue };
	};
	// A fact the long-term layer will carry (toggling memory republishes it), then the run under test.
	const seed = open();
	seed.queue.start();
	const first = await seed.dialogue.submit({
		requestId: crypto.randomUUID(),
		conversationId: "main",
		text: "私は辛いものが好きです",
	});
	await until(() => seed.dialogue.get(first.id)?.status === "completed");
	saveItem(store, memory, {
		conversationId: "main",
		messageId: first.inputMessageId,
		quote: "辛いものが好き",
		kind: "preference",
		semanticKey: "food.spicy",
		text: "辛いものが好き",
	});
	await memory.setEnabled(false);
	await memory.setEnabled(true);
	await seed.queue.close(100);
	const { queue, dialogue } = open();
	const callsBefore = seen.length;
	const run = await dialogue.submit({
		requestId: crypto.randomUUID(),
		conversationId: "main",
		text: "今日のニュースは？",
	});
	if (failureCode)
		await store.write((db) =>
			db
				.query("UPDATE dialogue_runs SET agent_task_id='t' WHERE id=?")
				.run(run.id),
		);
	queue.start();
	await until(() => dialogue.get(run.id)?.status === "completed");
	await queue.close(100);
	return {
		sent: seen.at(-1)!,
		session: sessions.at(-1)!,
		calls: seen.length - callsBefore,
		answer: dialogue.answerText(run.id),
	};
}

test("a failed research result is answered by the host: no model call is made for it", async () => {
	const { calls, answer } = await generate("agent_timeout");
	expect(calls).toBe(0);
	expect(answer).toBe(RESEARCH_FAILURE_REPLY);
});

test("without a research result the persona, long-term and goals layers are the instructions", async () => {
	const { sent, session } = await generate(null);
	const { instructionCount } = session.context!;
	expect(instructionCount).toBe(3);
	expect(
		sent.slice(0, instructionCount).every((m) => m.role === "system"),
	).toBe(true);
	expect(sent[1]!.content).toContain("辛いものが好き");
	expect(sent[2]!.content).toContain("毎日少し運動する");
});
