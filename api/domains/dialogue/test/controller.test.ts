import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { openStore } from "../../../infrastructure/sqlite";
import {
	migration as conversationMigration,
	createConversationService,
} from "../../conversation";
import type { LarmPort } from "../../larm";
import { createQueue, migration as queueMigration } from "../../queue";
import {
	createDialogueService,
	migration,
	queueLinkMigration,
	registerDialogue,
} from "..";

test("dialogue controller validates requests and delegates one run", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-controller-"));
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
			conversationMigration,
			migration,
			queueMigration,
			queueLinkMigration,
		]);
		const conversation = createConversationService(store);
		const queue = createQueue(store);
		queue.start();
		const dialogue = createDialogueService(store, conversation, larm, queue);
		const app = new Hono();
		registerDialogue(app, dialogue);
		const invalid = await app.request("/api/runs", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ text: "" }),
		});
		expect(invalid.status).toBe(400);
		const input = {
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: "質問",
		};
		const first = await app.request("/api/runs", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(input),
		});
		expect(first.status).toBe(202);
		const run = (await first.json()) as { id: string };
		const second = await app.request("/api/runs", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(input),
		});
		expect(((await second.json()) as { id: string }).id).toBe(run.id);
		const found = await app.request(`/api/runs/${run.id}`);
		expect(found.status).toBe(200);
		await queue.close(100);
		await store.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
