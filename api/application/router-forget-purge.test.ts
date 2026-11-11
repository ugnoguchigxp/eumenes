import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../infrastructure/config";
import { configureLogging } from "../infrastructure/logger";
import { createLifecycleRunner } from "./lifecycle";
import { createLifecycles } from "./server-lifecycles";
import { buildServices } from "./server-services";
import { toolchainForgetPurge } from "./toolchain/toolchain-forget";

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

test("router forget handles primary and secondary sources atomically across deletion batches", async () => {
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
		const related = crypto.randomUUID();
		const messageIds = [
			forgotten,
			...Array.from({ length: 249 }, () => crypto.randomUUID()),
			related,
		];
		await services.store.write((db) => {
			for (const id of [...messageIds, kept])
				services.conversation.appendInTransaction(db, {
					id,
					conversationId: "main",
					role: "user",
					text: "fixture message",
					createdAt: new Date().toISOString(),
				} as never);
			for (const [runId, messageId, sources] of [
				["run-forgotten", forgotten, []],
				["run-related", kept, [related]],
				["run-kept", kept, []],
			] as const) {
				history.recordRouterTraceInTransaction(db, {
					runId,
					conversationId: "main",
					messageId,
					messageIds: sources,
					text: "fixture message",
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
					messageIds: sources,
					text: "fixture message",
					query: { space, vector: [1, 0] },
					wrongId: "music.library",
					rightId: "music.create",
				});
			}
		});
		await services.memory.recover();
		const rows = () =>
			services.store.read((db) => ({
				traces: db
					.query("SELECT run_id FROM router_traces ORDER BY run_id")
					.all(),
				feedback: db
					.query("SELECT run_id FROM router_feedback ORDER BY run_id")
					.all(),
			}));
		const before = rows();
		const counts: number[] = [];
		configureLogging({
			level: "info",
			destination: {
				write(line) {
					const entry = JSON.parse(line);
					if (entry.event === "toolchain.router_forgotten")
						counts.push(entry.count);
				},
			},
		});
		await services.store.write((db) => {
			db.exec(`CREATE TRIGGER fixture_feedback_delete_failure BEFORE DELETE ON router_feedback
				WHEN OLD.run_id = 'run-related' BEGIN
					SELECT RAISE(ABORT, 'fixture_trace_not_deleted') WHERE EXISTS (
						SELECT 1 FROM router_traces WHERE run_id IN ('run-forgotten', 'run-related')
					);
					SELECT RAISE(ABORT, 'fixture_feedback_delete_failure');
				END`);
		});
		const purge = toolchainForgetPurge(services.toolchain);
		await expect(
			services.store.write((db) => purge(db, { messageIds, itemIds: [] })),
		).rejects.toThrow("fixture_feedback_delete_failure");
		expect(rows()).toEqual(before);
		expect(counts).toEqual([]);
		await services.store.write((db) =>
			db.exec("DROP TRIGGER fixture_feedback_delete_failure"),
		);
		await services.memory.forget({
			conversationId: "main",
			itemIds: [],
			messageIds,
		});
		expect(rows()).toEqual({
			traces: [{ run_id: "run-kept" }],
			feedback: [{ run_id: "run-kept" }],
		});
		expect(
			await services.store.write((db) =>
				history.forgetRouterInTransaction(db, messageIds),
			),
		).toBe(0);
		expect(counts).toEqual([4]);
	} finally {
		configureLogging({ level: "silent" });
		const items = createLifecycles(services, { name: "http", close: () => {} });
		await createLifecycleRunner(items).closeAll(15_000);
	}
}, 30_000);
