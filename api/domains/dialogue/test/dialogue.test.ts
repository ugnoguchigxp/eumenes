import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../../infrastructure/sqlite";
import {
	migrations as conversationMigrations,
	migration as conversationMigration,
	avatarMotionMigration as conversationAvatarMotionMigration,
	answerDeliveryMigration as conversationAnswerDeliveryMigration,
	createConversationService,
} from "../../conversation";
import type { LarmPort } from "../../larm";
import { createQueue, migration as queueMigration } from "../../queue";
import { createDialogueService, migration, queueLinkMigration } from "..";
import { pinnedToolchainMigration } from "../repository";
import { settle, waitFor } from "../../../infrastructure/wait-for";

async function awaitStatus(get: () => string | undefined, status: string) {
	await waitFor(() => get() === status);
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
		const dialogue = createDialogueService({
			store,
			conversation,
			larm,
			queue,
		});
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

test("a pinned toolchain is stored on the run and is part of the request's identity", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-dialogue-pinned-"));
	const larm: LarmPort = {
		status: () => ({ state: "ready", capabilities: ["llm"] }),
		connect: async () => {},
		answer: async () => "回答",
		transcribe: async () => "",
		speak: async () => new Uint8Array(),
		close: async () => {},
	};
	try {
		const store = openStore(join(dir, "db.sqlite3"), [
			...conversationMigrations,
			migration,
			queueMigration,
			queueLinkMigration,
			pinnedToolchainMigration,
		]);
		const conversation = createConversationService(store);
		const queue = createQueue(store);
		const dialogue = createDialogueService({
			store,
			conversation,
			larm,
			queue,
		});
		const input = {
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: "猫を描いて",
			presentation: "artifact" as const,
			toolchainId: "image.create",
		};
		const first = await dialogue.submit(input);
		expect(first.pinnedToolchainId).toBe("image.create");
		expect(dialogue.get(first.id)?.pinnedToolchainId).toBe("image.create");
		const job = store.read(
			(db) =>
				db
					.query("SELECT kind, payload_json FROM queue_jobs WHERE id = ?")
					.get(first.jobId) as { kind: string; payload_json: string },
		);
		expect(job.kind).toBe("dialogue.generate");
		expect(JSON.parse(job.payload_json)).toEqual({ runId: first.id });
		// The same request again is the same run; a different (or missing) toolchain is a conflict.
		expect((await dialogue.submit(input)).id).toBe(first.id);
		await expect(
			dialogue.submit({ ...input, toolchainId: "music.create" }),
		).rejects.toThrow("request_conflict");
		const { toolchainId: _unpinned, ...unpinned } = input;
		await expect(dialogue.submit(unpinned)).rejects.toThrow("request_conflict");
		const plain = await dialogue.submit({
			...unpinned,
			requestId: crypto.randomUUID(),
		});
		expect(plain.pinnedToolchainId).toBeNull();
		await expect(
			dialogue.submit({
				...unpinned,
				requestId: plain.requestId,
				toolchainId: "image.create",
			}),
		).rejects.toThrow("request_conflict");
		await queue.close(100);
		await store.close();
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
		readSnapshot: () => {
			throw new Error("storage_failed");
		},
		write: async () => {
			throw new Error("storage_failed");
		},
		close: async () => {},
	};
	const conversation = createConversationService(store);
	const queue = createQueue(store);
	const dialogue = createDialogueService({ store, conversation, larm, queue });
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
		const dialogue = createDialogueService({
			store,
			conversation,
			larm,
			queue,
		});
		const run = await dialogue.submit({
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: "先ほどの依頼",
		});
		await awaitStatus(() => dialogue.get(run.id)?.status, "running");
		expect((await dialogue.cancel(run.id))?.status).toBe("cancelled");
		resolveAnswer("古い回答");
		await settle();
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
