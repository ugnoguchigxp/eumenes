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
	agentLinkMigration,
	createDialogueService,
	migration,
	queueLinkMigration,
	type ToolchainRoutingPort,
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

function setup(projection: Record<string, unknown>) {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-guided-answer-"));
	dirs.push(dir);
	const store = openStore(join(dir, "db.sqlite3"), [
		conversationMigration,
		conversationAvatarMotionMigration,
		conversationAnswerDeliveryMigration,
		migration,
		queueMigration,
		queueLinkMigration,
		agentLinkMigration,
	]);
	stores.push(store);
	let generated = 0;
	const larm: LarmPort & InferencePort = {
		status: () => ({ state: "ready", capabilities: ["llm"] }),
		connect: async () => {},
		answer: async () => {
			generated++;
			return "生成された回答";
		},
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
		projection: JSON.stringify(projection),
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
	const recorded: unknown[] = [];
	const settled: unknown[] = [];
	const toolchains = {
		embedQuery: async () => undefined,
		recordSelectionInTransaction: (_db: unknown, input: unknown) => {
			recorded.push(input);
			return "selection";
		},
		settleSelectionInTransaction: (
			_db: unknown,
			_runId: string,
			result: unknown,
		) => {
			settled.push(result);
		},
	} as unknown as ToolchainRoutingPort;
	const dialogue = createDialogueService({
		store,
		conversation,
		larm,
		queue,
		agents,
		toolchains,
	});
	return {
		store,
		queue,
		dialogue,
		recorded,
		settled,
		generated: () => generated,
	};
}
const submit = async (h: ReturnType<typeof setup>) => {
	const run = await h.dialogue.submit({
		requestId: crypto.randomUUID(),
		conversationId: "main",
		text: "調べて",
	});
	await h.store.write((db) =>
		db
			.query("UPDATE dialogue_runs SET agent_task_id=? WHERE id=?")
			.run("t", run.id),
	);
	h.queue.start();
	return run;
};

test("a guided direct answer is adopted without generation and settles the selection once", async () => {
	const h = setup({
		delivery: "guided-web",
		answer: "調査結果の本文です。",
		outcome: "answered",
	});
	const run = await submit(h);
	await until(() => h.dialogue.get(run.id)?.status === "completed");
	expect(h.generated()).toBe(0);
	expect(h.settled).toEqual([{ outcome: "answered" }]);
	expect(h.recorded).toEqual([]);
	const stored = h.dialogue.get(run.id)!;
	const message = h.store.read((db) =>
		db
			.query("SELECT text FROM messages WHERE id=?")
			.get(stored.answerMessageId) as { text: string } | null,
	);
	expect(message?.text).toBe("調査結果の本文です。");
	await h.queue.close(100);
});

test("a guided direct answer without a reported outcome settles as completed", async () => {
	const h = setup({ delivery: "guided-web", answer: "本文" });
	const run = await submit(h);
	await until(() => h.dialogue.get(run.id)?.status === "completed");
	expect(h.settled).toEqual([{ outcome: "completed" }]);
	expect(h.recorded).toEqual([]);
	await h.queue.close(100);
});
