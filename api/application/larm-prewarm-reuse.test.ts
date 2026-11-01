import { expect, jest, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../infrastructure/sqlite";
import { settle } from "../infrastructure/wait-for";
import { migrations } from "./migrations";
import { createSettings } from "../domains/settings";
import { createInference } from "../domains/inference";
import {
	capacityFixture,
	messages,
	owner,
} from "../domains/larm/test/agent-capacity.fixture";
import { createConversationPrewarm } from "./conversation-prewarm";

test("the real idle prewarm, foreground SSE and task lifecycle reuse their managed connections for twenty minutes", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-prewarm-reuse-"));
	const dbPath = join(dir, "fixture.db"),
		store = openStore(dbPath, migrations);
	const settings = await createSettings(store, { dbPath, env: {} });
	const f = capacityFixture(),
		saved = settings.get();
	saved.larm.baseUrl = f.config.baseUrl;
	saved.larm.profile = f.config.profile;
	saved.routes.llm.mode = "larm-only";
	saved.routes.llm.cloudAllowed = false;
	await settings.apply({
		requestId: crypto.randomUUID(),
		expectedRevision: saved.revision,
		settings: saved,
		keys: [],
	});
	jest.useFakeTimers();
	let completed = 0;
	const inference = createInference(store, settings, {
		token: f.config.token,
		fetch: f.config.fetch,
		keepLarmConnection: true,
	});
	const prewarm = createConversationPrewarm({
		store,
		inference: {
			...inference,
			rejectControlInTransaction(db, receipt, code) {
				inference.rejectControlInTransaction(db, receipt, code);
				completed++;
			},
		},
		latestConversationIdInTransaction: () => "conversation-a",
		task: () => ({ messages }),
	});
	const foreground = async (role: "main" | "subagent") => {
		const id = await store.write((db) =>
			inference.captureInTransaction!(
				db,
				crypto.randomUUID(),
				"llm",
				Date.now() + 5000,
			),
		);
		return inference.executeStream!(
			id,
			messages,
			AbortSignal.timeout(5000),
			() => {},
			undefined,
			undefined,
			owner(
				role,
				"conversation-a",
				role === "main" ? "conversation-a" : "task-a",
			),
		);
	};
	try {
		await inference.connect();
		expect(f.creates).toHaveLength(0);
		inference.screenPresence("fixture-screen", 1, true, Date.now());
		prewarm.start();
		await settle(100);
		expect(completed).toBe(1);
		expect((await foreground("main")).value).toBe("ok");
		for (let i = 0; i < 40; i++) {
			jest.advanceTimersByTime(30000);
			inference.screenPresence("fixture-screen", i + 2, true, Date.now());
			await settle(60);
		}
		expect(completed).toBeGreaterThanOrEqual(5);
		expect(inference.status().state).toBe("ready");
		expect(f.bindings.size).toBe(1);
		expect(inference.inspect().agentConnections).toMatchObject([
			{
				conversationId: "conversation-a",
				agentId: "conversation-a",
				role: "main",
				requestedTokens: 200000,
			},
		]);
		expect((await foreground("main")).value).toBe("ok");
		expect(new Set(f.generations.map((g) => g.id)).size).toBe(1);
		expect(
			new Set(f.generations.map((g) => g.body.prompt_cache_key)).size,
		).toBe(1);
		expect((await foreground("subagent")).value).toBe("ok");
		const subId = f.generations.at(-1)!.id;
		expect(f.bindings.get(subId)!.capacity).toBe(131072);
		await inference.releaseTaskSession("task-a");
		expect(f.bindings.get(subId)!.released).toBeTrue();
		expect(inference.inspect().agentConnections).toHaveLength(1);
	} finally {
		prewarm.close();
		await inference.close();
		jest.useRealTimers();
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
