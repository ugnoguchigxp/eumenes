import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../../infrastructure/sqlite";
import { waitFor } from "../../../infrastructure/wait-for";
import {
	migration as conversationMigration,
	avatarMotionMigration as conversationAvatarMotionMigration,
	answerDeliveryMigration as conversationAnswerDeliveryMigration,
	createConversationService,
} from "../../conversation";
import type { LarmPort } from "../../larm";
import { createQueue, migration as queueMigration } from "../../queue";
import { createDialogueService, migration, queueLinkMigration } from "..";

test("a conversation has an active run from acceptance until the run ends, and only that conversation", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-active-run-"));
	let release: () => void = () => {};
	const gate = new Promise<void>((resolve) => (release = resolve));
	const larm: LarmPort = {
		status: () => ({ state: "ready", capabilities: ["llm"] }),
		connect: async () => {},
		answer: async () => {
			await gate;
			return "お答えします";
		},
		transcribe: async () => "",
		speak: async () => new Uint8Array(),
		close: async () => {},
	};
	const store = openStore(join(dir, "db.sqlite3"), [
		conversationMigration,
		conversationAvatarMotionMigration,
		conversationAnswerDeliveryMigration,
		migration,
		queueMigration,
		queueLinkMigration,
	]);
	const queue = createQueue(store);
	try {
		queue.start();
		const dialogue = createDialogueService({
			store,
			conversation: createConversationService(store),
			larm,
			queue,
		});
		const active = (conversationId: string) =>
			store.read((db) =>
				dialogue.conversationHasActiveRunInTransaction(db, conversationId),
			);
		expect(active("main")).toBe(false);
		const run = await dialogue.submit({
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: "こんにちは",
		});
		expect(active("main")).toBe(true);
		expect(active("other")).toBe(false);
		release();
		await waitFor(() => dialogue.get(run.id)?.status === "completed");
		expect(active("main")).toBe(false);
	} finally {
		release();
		await queue.close(100);
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
