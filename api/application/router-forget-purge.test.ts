import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../infrastructure/config";
import { createLifecycleRunner } from "./lifecycle";
import { createLifecycles } from "./server-lifecycles";
import { buildServices } from "./server-services";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

const space = {
	modelId: "fixture-embedding",
	revision: "r1",
	artifactDigest: "d1",
	dimension: 2,
};

test("a forget of an utterance removes the router's trace and the correction made from it (spec toolchain-router-redesign §5.4)", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-router-purge-"));
	dirs.push(dir);
	const services = await buildServices(
		loadConfig({
			EUMENES_DB: join(dir, "db.sqlite3"),
			EUMENES_TOOLCHAIN_ENABLED: "0",
			EUMENES_WORLD: "protect",
		}),
	);
	try {
		const history = services.toolchain.history;
		const forgotten = crypto.randomUUID();
		const kept = crypto.randomUUID();
		await services.store.write((db) => {
			for (const [id, text] of [
				[forgotten, "コーヒータイムに合う曲を作って"],
				[kept, "明日の天気は？"],
			] as const)
				services.conversation.appendInTransaction(db, {
					id,
					conversationId: "main",
					role: "user",
					text,
					createdAt: new Date().toISOString(),
				} as never);
			for (const [runId, messageId, text] of [
				["run-forgotten", forgotten, "コーヒータイムに合う曲を作って"],
				["run-kept", kept, "明日の天気は？"],
			] as const) {
				history.recordRouterTraceInTransaction(db, {
					runId,
					conversationId: "main",
					messageId,
					text,
					query: { space, vector: [1, 0] },
					trace: {
						mode: "on",
						revision: null,
						model: null,
						candidates: [],
						set: [],
						row: 2,
						decided: "music.library",
						durationMs: 1,
						error: null,
					},
				});
				history.recordRouterFeedbackInTransaction(db, {
					conversationId: "main",
					messageId,
					runId,
					source: "redirect",
					text,
					query: { space, vector: [1, 0] },
					wrongId: "music.library",
					rightId: "music.create",
				});
			}
		});
		await services.memory.recover();
		await services.memory.forget({
			conversationId: "main",
			itemIds: [],
			messageIds: [forgotten],
		});
		expect(
			services.store.read((db) => ({
				traces: db
					.query("SELECT run_id FROM router_traces ORDER BY run_id")
					.all(),
				feedback: db
					.query("SELECT run_id FROM router_feedback ORDER BY run_id")
					.all(),
			})),
		).toEqual({
			traces: [{ run_id: "run-kept" }],
			feedback: [{ run_id: "run-kept" }],
		});
	} finally {
		const items = createLifecycles(services, { name: "http", close: () => {} });
		await createLifecycleRunner(items).closeAll(15_000);
	}
}, 30_000);
