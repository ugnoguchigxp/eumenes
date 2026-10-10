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
	type PostAnswerObserverPort,
} from "..";

const dirs: string[] = [];
const stores: SqliteStore[] = [];
afterEach(async () => {
	for (const s of stores.splice(0)) await s.close().catch(() => {});
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
async function until(cond: () => boolean) {
	for (let i = 0; i < 300; i++) {
		if (cond()) return;
		await new Promise((r) => setTimeout(r, 5));
	}
	throw new Error("condition not reached");
}
function setup(postAnswer?: PostAnswerObserverPort, withTicket = true) {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-post-"));
	dirs.push(dir);
	const store = openStore(join(dir, "db.sqlite3"), [
		conversationMigration,
		conversationAvatarMotionMigration,
		conversationAnswerDeliveryMigration,
		migration,
		queueMigration,
		queueLinkMigration,
		agentLinkMigration,
		"CREATE TABLE observed_marker(id TEXT PRIMARY KEY)",
	]);
	stores.push(store);
	const larm: LarmPort & InferencePort = {
		status: () => ({ state: "ready", capabilities: ["llm"] }),
		connect: async () => {},
		answer: async () => "回答",
		transcribe: async () => "",
		speak: async () => new Uint8Array(),
		close: async () => {},
	};
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
		failureCode: null,
	};
	const agents = {
		startInTransaction(
			db: any,
			input: { rootRunId: string; deadline: number },
		) {
			const { job } = queue.enqueueInTransaction(db, {
				scope: "dialogue",
				kind: "dialogue.generate",
				dedupeKey: input.rootRunId,
				payload: { runId: input.rootRunId },
				subjectRef: input.rootRunId,
				lane: "interactive",
				resourceKey: "inference.llm",
				maxAttempts: 1,
				concurrencyKey: "conversation:main",
			});
			return { taskId: "t", jobId: job.id };
		},
		prepareAnswerInTransaction: () => ticket,
		completeAnswerInTransaction: () => {},
		validAnswerInTransaction: () => true,
		failAnswerInTransaction: () => {},
		pendingEvents: () => [],
		byRootInTransaction: () => null,
	} as unknown as AgentRuntime;
	const dialogue = createDialogueService({
		store,
		conversation,
		larm,
		queue,
		agents: withTicket ? agents : undefined,
		postAnswer,
	});
	return { store, queue, dialogue };
}
const submit = async (h: ReturnType<typeof setup>) => {
	const run = await h.dialogue.submit({
		requestId: crypto.randomUUID(),
		conversationId: "main",
		text: "q",
	});
	await h.store.write((db) =>
		db
			.query("UPDATE dialogue_runs SET agent_task_id=? WHERE id=?")
			.run("t", run.id),
	);
	h.queue.start();
	return run;
};

test("E01 observer is called after adoption with ids only and its writes commit", async () => {
	const calls: unknown[] = [];
	const h = setup({
		recordInTransaction(db, input) {
			calls.push(input);
			db.query("INSERT INTO observed_marker VALUES (?)").run(input.runId);
			return { status: "recorded" };
		},
	});
	const run = await submit(h);
	await until(() => h.dialogue.get(run.id)?.status === "completed");
	expect(calls).toEqual([
		{ runId: run.id, ticketId: "event-1", reportEpoch: 3 },
	]);
	expect(
		h.store.read((db) =>
			db.query("SELECT count(*) n FROM observed_marker").get(),
		),
	).toEqual({ n: 1 });
	await h.queue.close(100);
});

test("E01 observer throw or skipped rolls back only the learning part", async () => {
	for (const mode of ["throw", "skipped"] as const) {
		const h = setup({
			recordInTransaction(db, input) {
				db.query("INSERT INTO observed_marker VALUES (?)").run(input.runId);
				if (mode === "throw") throw new Error("queue_full");
				return { status: "skipped", code: "skipped_capacity" };
			},
		});
		const run = await submit(h);
		await until(() => h.dialogue.get(run.id)?.status === "completed");
		expect(h.dialogue.get(run.id)?.answerMessageId).not.toBeNull();
		expect(
			h.store.read((db) =>
				db.query("SELECT count(*) n FROM observed_marker").get(),
			),
		).toEqual({ n: 0 });
		await h.queue.close(100);
	}
});

test("E01 without an observer the answer completes as before", async () => {
	const h = setup(undefined);
	const run = await submit(h);
	await until(() => h.dialogue.get(run.id)?.status === "completed");
	await h.queue.close(100);
});
