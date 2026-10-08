import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../../infrastructure/sqlite";
import {
	migration as conversationMigration,
	avatarMotionMigration as conversationAvatarMotionMigration,
	answerDeliveryMigration as conversationAnswerDeliveryMigration,
	createConversationService,
} from "../../conversation";
import type { LarmPort } from "../../larm";
import { createQueue, migration as queueMigration } from "../../queue";
import { createDialogueService, migration, queueLinkMigration } from "..";

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function awaitStatus(get: () => string | undefined, status: string) {
	for (let i = 0; i < 100; i++) {
		if (get() === status) return;
		await pause(10);
	}
	throw new Error(`expected ${status}, got ${get()}`);
}

test("request ID is idempotent and answer adoption is atomic", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-dialogue-"));
	const file = join(dir, "db.sqlite3");
	let calls = 0;
	const larm: LarmPort = {
		status: () => ({ state: "ready", capabilities: ["llm"] }),
		connect: async () => {},
		answer: async () => {
			calls++;
			return "お答えします";
		},
		transcribe: async () => "",
		speak: async () => new Uint8Array(),
		close: async () => {},
	};
	try {
		const store = openStore(file, [
			conversationMigration,
			conversationAvatarMotionMigration,
			conversationAnswerDeliveryMigration,
			migration,
			queueMigration,
			queueLinkMigration,
		]);
		const conversation = createConversationService(store);
		const queue = createQueue(store);
		queue.start();
		const dialogue = createDialogueService(store, conversation, larm, queue);
		const input = {
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: "こんにちは",
		};
		const first = await dialogue.submit(input);
		const duplicate = await dialogue.submit(input);
		expect(duplicate.id).toBe(first.id);
		await expect(
			dialogue.submit({ ...input, text: "異なる本文" }),
		).rejects.toThrow("request_conflict");
		await awaitStatus(() => dialogue.get(first.id)?.status, "completed");
		expect(calls).toBe(1);
		expect(conversation.get("main").messages.map((m) => m.text)).toEqual([
			"こんにちは",
			"お答えします",
		]);
		await queue.close(100);
		await store.close();
		const reopened = openStore(file, [
			conversationMigration,
			conversationAvatarMotionMigration,
			conversationAnswerDeliveryMigration,
			migration,
			queueMigration,
			queueLinkMigration,
		]);
		expect(
			createConversationService(reopened).get("main").messages,
		).toHaveLength(2);
		await reopened.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("failed input persistence prevents any provider request", async () => {
	let calls = 0;
	const larm: LarmPort = {
		status: () => ({ state: "ready", capabilities: ["llm"] }),
		connect: async () => {},
		answer: async () => {
			calls++;
			return "answer";
		},
		transcribe: async () => "",
		speak: async () => new Uint8Array(),
		close: async () => {},
	};
	const store = {
		onCommit: () => () => {},
		read: () => {
			throw new Error("storage_failed");
		},
		write: async () => {
			throw new Error("storage_failed");
		},
		close: async () => {},
	};
	const conversation = createConversationService(store);
	const queue = createQueue(store);
	const dialogue = createDialogueService(store, conversation, larm, queue);
	await expect(
		dialogue.submit({
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: "test",
		}),
	).rejects.toThrow("storage_failed");
	expect(calls).toBe(0);
});

test("cancelled inference cannot append an answer", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-cancel-"));
	let resolveAnswer: (text: string) => void = () => {};
	const larm: LarmPort = {
		status: () => ({ state: "ready", capabilities: ["llm"] }),
		connect: async () => {},
		answer: () =>
			new Promise((resolve) => {
				resolveAnswer = resolve;
			}),
		transcribe: async () => "",
		speak: async () => new Uint8Array(),
		close: async () => {},
	};
	try {
		const store = openStore(join(dir, "db.sqlite3"), [
			conversationMigration,
			conversationAvatarMotionMigration,
			conversationAnswerDeliveryMigration,
			migration,
			queueMigration,
			queueLinkMigration,
		]);
		const conversation = createConversationService(store);
		const queue = createQueue(store);
		queue.start();
		const dialogue = createDialogueService(store, conversation, larm, queue);
		const run = await dialogue.submit({
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: "先ほどの依頼",
		});
		await awaitStatus(() => dialogue.get(run.id)?.status, "running");
		expect((await dialogue.cancel(run.id))?.status).toBe("cancelled");
		resolveAnswer("古い回答");
		await pause(20);
		expect(dialogue.get(run.id)?.status).toBe("cancelled");
		expect(conversation.get("main").messages.map((m) => m.text)).toEqual([
			"先ほどの依頼",
		]);
		await queue.close(100);
		await store.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
