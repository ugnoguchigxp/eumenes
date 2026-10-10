import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../../infrastructure/sqlite";
import {
	createCapabilities,
	migration as capMigration,
} from "../../capabilities";
import { createQueue, migration as queueMigration } from "../../queue";
import { createToolRuntime, migration, type ToolAdapter } from "..";
test("gateway refuses foreign refs and unselected URLs; idempotent invocation and rolled-back result is not exposed", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-tools-"));
	const store = openStore(join(dir, "db"), [
		capMigration,
		queueMigration,
		migration,
	]);
	const caps = createCapabilities(store),
		queue = createQueue(store);
	let calls = 0;
	let time = Date.now();
	const adapter: ToolAdapter = {
		startInTransaction: () => {
			calls++;
			return { operationId: "op", jobId: "job" };
		},
		get: () => ({
			state: "succeeded",
			result: {
				observedAt: new Date().toISOString(),
				hits: [
					{ url: "https://example.com", title: "result", snippet: "fact" },
				],
				documents: [],
				failures: [],
			},
		}),
		cancelInTransaction: () => [],
	};
	const tools = createToolRuntime(store, caps, queue, adapter, () => time);
	try {
		await caps.seed();
		const owner = { rootRunId: "root", taskId: "child", cancelEpoch: 0 };
		const refs = await store.write((db) => {
			return tools.bind(
				owner,
				caps.prepareActiveByIdInTransaction(
					db,
					owner,
					"package:web.research@9",
					{ question: "天気" },
				),
				Date.now() + 100000,
			);
		});
		const lookup = refs.find((r) => r.tool.id === "web.lookup")!,
			read = refs.find((r) => r.tool.id === "web.read")!;
		await expect(
			store.write((db) =>
				tools.invokeInTransaction(
					db,
					{ ...owner, taskId: "wrong" },
					lookup.executionRef,
					{ query: "天気" },
					"step",
					Date.now() + 100000,
					"parent",
					[],
				),
			),
		).rejects.toThrow("tool_ref_invalid");
		await expect(
			store.write((db) =>
				tools.invokeInTransaction(
					db,
					owner,
					read.executionRef,
					{ url: "https://evil.example" },
					"step",
					Date.now() + 100000,
					"parent",
					[],
				),
			),
		).rejects.toThrow("tool_url_out_of_scope");
		expect(calls).toBe(0);
		const inv = await store.write((db) =>
			tools.invokeInTransaction(
				db,
				owner,
				lookup.executionRef,
				{ query: "天気" },
				"step",
				Date.now() + 100000,
				"parent",
				[],
			),
		);
		expect(
			(
				await store.write((db) =>
					tools.invokeInTransaction(
						db,
						owner,
						lookup.executionRef,
						{ query: "天気" },
						"step",
						Date.now() + 100000,
						"parent",
						[],
					),
				)
			).id,
		).toBe(inv.id);
		expect(calls).toBe(1);
		await expect(
			store.write((db) =>
				tools.invokeInTransaction(
					db,
					owner,
					lookup.executionRef,
					{ query: "別の依頼" },
					"step",
					Date.now() + 100000,
					"parent",
					[],
				),
			),
		).rejects.toThrow("idempotency_conflict");
		await expect(
			store.write((db) =>
				tools.invokeInTransaction(
					db,
					{ ...owner, taskId: "wrong" },
					lookup.executionRef,
					{ query: "天気" },
					"step",
					Date.now() + 100000,
					"parent",
					[],
				),
			),
		).rejects.toThrow("tool_ref_invalid");
		// Rolled-back attempts must not consume the entire shared result capacity.
		for (let attempt = 0; attempt < 64; attempt++)
			await expect(
				store.write((db) => {
					tools.settleInTransaction(db, inv, adapter.get("op"));
					throw new Error("rollback");
				}),
			).rejects.toThrow("rollback");
		expect(
			store.read(
				(db) => tools.observationsInTransaction(db, owner.taskId)[0]?.sources,
			),
		).toHaveLength(0);
		await store.write((db) =>
			tools.settleInTransaction(db, inv, adapter.get("op")),
		);
		expect(
			store.read(
				(db) =>
					tools.observationsInTransaction(db, owner.taskId)[0]?.sources[0]
						?.body,
			),
		).toBe("fact");
		time = Date.now() + 1_000_000;
		expect(() =>
			store.read((db) => tools.observationsInTransaction(db, owner.taskId)),
		).toThrow("result_expired");
	} finally {
		tools.close();
		await queue.close(100);
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
