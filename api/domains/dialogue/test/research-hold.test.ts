/**
 * A failed research root has no projection, but its answer is still filtered
 * by researchCitations at the end. The body must therefore be held while
 * streaming too, or unfiltered partial text reaches SSE and speech first.
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

const dirs: string[] = [];
const stores: SqliteStore[] = [];
afterEach(async () => {
	for (const s of stores.splice(0)) await s.close().catch(() => {});
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
async function until(cond: () => boolean) {
	for (let i = 0; i < 400; i++) {
		if (cond()) return;
		await new Promise((r) => setTimeout(r, 5));
	}
	throw new Error("condition not reached");
}

test("a failed research answer streams no partial text and its final text carries no ungranted URL", async () => {
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
	const observed: string[] = [];
	let runId = "";
	let dialogue: ReturnType<typeof createDialogueService>;
	const answerText =
		"調べられませんでした。詳細は https://evil.example/x を参照。";
	const larm = {
		status: () => ({ state: "ready", capabilities: ["llm"] }),
		connect: async () => {},
		answerStream: async (
			_messages: unknown,
			_signal: unknown,
			onDelta: (text: string) => void,
		) => {
			for (const part of [
				"調べられませんでした。",
				"詳細は https://evil.",
				"example/x を参照。",
			]) {
				onDelta(part);
				observed.push(dialogue.progress(runId)?.text ?? "");
			}
			return answerText;
		},
		answer: async () => answerText,
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
	runId = run.id;
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
	expect(observed.length).toBe(3);
	expect(observed.every((text) => text === "")).toBe(true);
	const final = dialogue.progress(run.id)?.text ?? "";
	expect(final).toContain("調べられませんでした");
	expect(final).not.toContain("evil.example");
	await queue.close(100);
});
