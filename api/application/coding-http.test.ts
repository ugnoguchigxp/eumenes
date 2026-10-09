import { expect, test } from "bun:test";
import { join } from "node:path";
import { createApp } from "./app";
import { createClient } from "../../client";
import { createCoding } from "../domains/coding";
import { migrations } from "./migrations";
import { createQueue } from "../domains/queue";
import { createScheduler } from "../domains/scheduler";
import { createConversationService } from "../domains/conversation";
import { createDialogueService } from "../domains/dialogue";
import { createVoiceDialogue } from "../domains/voice-dialogue";
import type { LarmPort } from "../domains/larm";
import { openStore } from "../infrastructure/sqlite";
import { connectRunner } from "../../packages/coding-runner/src/client";
import { publishSpec } from "../../packages/coding-runner/src/core";
import { fixture } from "../../packages/coding-runner/test/support";

test("coding HTTP/client authenticate reads, validate cursors and hide private execution fields", async () => {
	const f = fixture();
	const store = openStore(join(f.root, "test.sqlite"), migrations);
	const runner = await connectRunner({
		executable: process.execPath,
		serverPath: join(
			import.meta.dir,
			"../../packages/coding-runner/test/fixture-server.ts",
		),
		configPath: f.configPath,
	});
	const coding = createCoding({
		store,
		runner,
		publishSpec: (ref, spec) => publishSpec(f.config, ref, spec),
	});
	const token = "fixture-token".repeat(3);
	const queue = createQueue(store),
		scheduler = createScheduler(store, queue),
		conversation = createConversationService(store);
	const larm: LarmPort = {
		status: () => ({ state: "ready", capabilities: ["llm"] }),
		connect: async () => {},
		close: async () => {},
		answer: async () => "fixture",
		transcribe: async () => "",
		speak: async () => new Uint8Array(),
	};
	const dialogue = createDialogueService({ store, queue, conversation, larm }),
		voice = createVoiceDialogue(store, dialogue, larm);
	const app = createApp({
		token,
		origin: "http://127.0.0.1:5173",
		coding,
		queue,
		scheduler,
		conversation,
		dialogue,
		voice,
		larm,
	});
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: app.fetch,
	});
	try {
		await store.write((db) =>
			coding.registerWorkspaceInTransaction(db, {
				id: "fixture",
				branch: "codex/fixture",
				available: true,
				reason: null,
			}),
		);
		const p = await store.write((db) =>
			coding.prepareInTransaction(
				db,
				{
					taskId: "task",
					generation: 1,
					authorityEpoch: 1,
					workspaceId: "fixture",
					branch: "codex/fixture",
					operations: ["read"],
					network: "none",
					deadlineAt: Date.now() + 10000,
				},
				{
					operationId: crypto.randomUUID(),
					instruction: "private instruction",
					kind: "implement",
				},
			),
		);
		const client = createClient(`http://127.0.0.1:${server.port}`, token);
		expect((await client.codingWorkspaces()).items[0]!.id).toBe("fixture");
		const view = await client.codingExecution(p.spec.executionId);
		expect(view.state).toBe("intent");
		expect(JSON.stringify(view)).not.toContain("private instruction");
		expect(view).not.toHaveProperty("sessionId");
		expect(
			(await client.codingExecutionEvents(p.spec.executionId)).events,
		).toHaveLength(0);
		expect(
			(await app.request(`/api/coding/executions/${p.spec.executionId}`))
				.status,
		).toBe(401);
		expect(
			(
				await app.request(
					`/api/coding/executions/${p.spec.executionId}/events?after=-1`,
					{ headers: { authorization: `Bearer ${token}` } },
				)
			).status,
		).toBe(400);
		expect(
			(
				await app.request("/api/coding/executions/missing", {
					headers: { authorization: `Bearer ${token}` },
				})
			).status,
		).toBe(404);
	} finally {
		server.stop(true);
		await runner.close();
		await scheduler.close();
		await queue.close();
		await voice.close();
		await dialogue.close();
		await store.close();
		f.close();
	}
});
