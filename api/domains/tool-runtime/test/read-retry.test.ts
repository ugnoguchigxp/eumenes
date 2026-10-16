import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../../infrastructure/sqlite";
import {
	createCapabilities,
	migration as capMigration,
} from "../../capabilities";
import { createQueue, migration as queueMigration } from "../../queue";
import { createToolRuntime, migrations, type ToolAdapter } from "..";

test("failure-only partial reads retry on a new step without bypassing budget; usable partial bodies replay", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-read-retry-"));
	const store = openStore(join(dir, "db"), [
		capMigration,
		queueMigration,
		...migrations,
	]);
	const caps = createCapabilities(store),
		queue = createQueue(store);
	let calls = 0;
	const adapter: ToolAdapter = {
		startInTransaction: () => ({
			operationId: `op${++calls}`,
			jobId: `job${calls}`,
		}),
		get: () => null,
		cancelInTransaction: () => [],
	};
	const tools = createToolRuntime(store, caps, queue, adapter);
	const owner = { rootRunId: "root", taskId: "worker", cancelEpoch: 0 };
	const url = "https://example.org/read";
	const deadline = Date.now() + 100000;
	try {
		await caps.seed();
		const refs = await store.write((db) =>
			tools.bind(
				owner,
				caps.prepareActiveByIdInTransaction(
					db,
					owner,
					"package:web.research@9",
					{ question: "本文を確認" },
				),
				deadline,
			),
		);
		const read = refs.find((r) => r.tool.id === "web.read")!;
		const invoke = (step: string, allowNew = true) =>
			store.write((db) =>
				tools.invokeInTransaction(
					db,
					owner,
					read.executionRef,
					{ url },
					step,
					deadline,
					"parent",
					[url],
					undefined,
					allowNew,
				),
			);
		const first = await invoke("first");
		const failures = [
			{ url, code: "web_rate_limited", retryable: true, cooldownMs: 1500 },
		];
		await store.write((db) =>
			tools.settleInTransaction(db, first, {
				state: "partial",
				result: {
					observedAt: new Date().toISOString(),
					hits: [],
					documents: [],
					failures,
				},
			}),
		);
		expect((await invoke("first", false)).id).toBe(first.id);
		await expect(invoke("budget-denied", false)).rejects.toThrow(
			"agent_budget_exhausted",
		);
		expect(calls).toBe(1);
		const retry = await invoke("retry");
		expect(retry.id).not.toBe(first.id);
		expect(calls).toBe(2);
		await store.write((db) =>
			tools.settleInTransaction(db, retry, {
				state: "partial",
				result: {
					observedAt: new Date().toISOString(),
					hits: [],
					failures,
					documents: [
						{
							url,
							title: "取得済み本文",
							text: "本文にある確認済みの情報。",
							fetchedAt: new Date().toISOString(),
							truncated: true,
						},
					],
				},
			}),
		);
		expect((await invoke("reuse-body", false)).id).toBe(retry.id);
		expect(calls).toBe(2);
		expect(
			store.read((db) => tools.invocationsInTransaction(db, owner.taskId)),
		).toHaveLength(2);
		await expect(
			store.write((db) =>
				tools.invokeInTransaction(
					db,
					owner,
					read.executionRef,
					{ url },
					"foreign-url",
					deadline,
					"parent",
					[],
					undefined,
					false,
				),
			),
		).rejects.toThrow("tool_url_out_of_scope");
	} finally {
		tools.close();
		await queue.close(100);
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
