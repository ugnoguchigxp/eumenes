/**
 * A failed research root is answered by the host: the model is never called, no partial text is streamed, and the
 * adopted text is the fixed reply that the voice delivery then speaks like any completed answer.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type SqliteStore } from "../../../infrastructure/sqlite";
import type { AgentRuntime, AnswerTicket } from "../../agent-runtime";
import {
	migration as conversationMigration,
	avatarMotionMigration as conversationAvatarMotionMigration,
	answerDeliveryMigration as conversationAnswerDeliveryMigration,
	createConversationService,
} from "../../conversation";
import type { InferencePort } from "../../inference";
import type { LarmPort } from "../../larm";
import { createQueue, migration as queueMigration } from "../../queue";
import {
	createDialogueService,
	agentLinkMigration,
	migration,
	queueLinkMigration,
	worldStateMigration,
} from "..";
import { RESEARCH_FAILURE_REPLY } from "../service/research-failure-reply";
import { waitFor as until } from "../../../infrastructure/wait-for";

const dirs: string[] = [];
const stores: SqliteStore[] = [];
afterEach(async () => {
	for (const s of stores.splice(0)) await s.close().catch(() => {});
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

test("a failed research is answered by the fixed reply without a model call", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-research-hold-"));
	dirs.push(dir);
	const store = openStore(join(dir, "db.sqlite3"), [
		conversationMigration,
		conversationAvatarMotionMigration,
		conversationAnswerDeliveryMigration,
		migration,
		queueMigration,
		queueLinkMigration,
		agentLinkMigration,
		worldStateMigration,
	]);
	stores.push(store);
	let calls = 0;
	let dialogue: ReturnType<typeof createDialogueService>;
	const larm = {
		status: () => ({ state: "ready", capabilities: ["llm"] }),
		connect: async () => {},
		answerStream: async () => {
			calls++;
			return "model";
		},
		answer: async () => {
			calls++;
			return "model";
		},
		transcribe: async () => "",
		speak: async () => new Uint8Array(),
		close: async () => {},
	} as unknown as LarmPort & InferencePort;
	const conversation = createConversationService(store);
	const queue = createQueue(store);
	const ticket: AnswerTicket = {
		taskId: "t",
		eventId: "event-1",
		revision: 1,
		dataEpoch: 0,
		reportTaskId: "c",
		reportEpoch: 3,
		reportDigest: null,
		projection: null,
		failureCode: "research_failed",
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
	dialogue = createDialogueService({
		store,
		conversation,
		larm,
		queue,
		agents,
	});
	const run = await dialogue.submit({
		requestId: crypto.randomUUID(),
		conversationId: "main",
		text: "q",
	});
	await store.write((db) =>
		db
			.query("UPDATE dialogue_runs SET agent_task_id='t' WHERE id=?")
			.run(run.id),
	);
	queue.start();
	await until(() =>
		["completed", "failed", "cancelled"].includes(
			dialogue.get(run.id)?.status ?? "",
		),
	);
	expect(dialogue.get(run.id)?.status).toBe("completed");
	expect(calls).toBe(0);
	expect(dialogue.answerText(run.id)).toBe(RESEARCH_FAILURE_REPLY);
	expect(dialogue.progress(run.id)?.text ?? "").toBe(RESEARCH_FAILURE_REPLY);
	await queue.close(100);
});
