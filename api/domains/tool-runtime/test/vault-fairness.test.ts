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
test("one task filling its result-vault quota cannot make another task's settle fail", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-vault-"));
	const store = openStore(join(dir, "db"), [
		capMigration,
		queueMigration,
		migration,
	]);
	const caps = createCapabilities(store),
		queue = createQueue(store);
	let seq = 0;
	const adapter: ToolAdapter = {
		startInTransaction: () => {
			seq++;
			return { operationId: `op${seq}`, jobId: `job${seq}` };
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
	const tools = createToolRuntime(store, caps, queue, adapter, Date.now);
	try {
		await caps.seed();
		const bind = (taskId: string) => {
			const owner = { rootRunId: "root", taskId, cancelEpoch: 0 };
			return store.write((db) => ({
				owner,
				refs: tools.bind(
					owner,
					caps.prepareActiveByIdInTransaction(
						db,
						owner,
						"package:web.research@9",
						{ question: "天気" },
					),
					Date.now() + 100000,
				),
			}));
		};
		const a = await bind("task-a"),
			b = await bind("task-b");
		const settleNext = async (t: typeof a, n: number) => {
			const lookup = t.refs.find((r) => r.tool.id === "web.lookup")!;
			const inv = await store.write((db) =>
				tools.invokeInTransaction(
					db,
					t.owner,
					lookup.executionRef,
					{ query: `q${n}` },
					`step${n}`,
					Date.now() + 100000,
					"parent",
					[],
				),
			);
			await store.write((db) =>
				tools.settleInTransaction(db, inv, adapter.get("op")),
			);
			return store.read(
				(db) =>
					db
						.query("SELECT state,error_code FROM tool_invocations WHERE id=?")
						.get(inv.id) as { state: string; error_code: string | null },
			);
		};
		for (let n = 0; n < 16; n++)
			expect((await settleNext(a, n)).state).toBe("succeeded");
		expect(await settleNext(a, 16)).toMatchObject({
			state: "failed",
			error_code: "result_capacity",
		});
		expect((await settleNext(b, 100)).state).toBe("succeeded");
	} finally {
		tools.close();
		await queue.close(100);
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
