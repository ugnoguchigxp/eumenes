import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../../infrastructure/sqlite";
import {
	createCapabilities,
	migrations as capMigrations,
} from "../../capabilities";
import { createQueue, migration as queueMigration } from "../../queue";
import {
	createToolRuntime,
	migrations,
	type ActionAdapter,
	type ActionEnvelope,
} from "..";
import type { CapabilityReads } from "../service/action-types";

test("agent action invocation stores the adapter and operation of its binding and reads through them", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-action-invoke-"));
	const store = openStore(join(dir, "db"), [
		...capMigrations,
		queueMigration,
		...migrations,
	]);
	const caps = createCapabilities(store, new Set(["web", "timer"]));
	const queue = createQueue(store);
	// The real capabilities service satisfies the ledger's narrow read interface.
	const reads_: CapabilityReads = caps;
	expect(reads_.artifactsInTransaction).toBeFunction();
	const seen: Array<{
		adapterRef: string;
		operationName: string;
		requestId: string;
	}> = [];
	const reads: string[] = [];
	const envelope = (adapterRef: string, id: string): ActionEnvelope => ({
		kind: "local_action",
		adapterRef,
		version: 1,
		operationId: id,
		receiptDigest: `digest-${id}`,
		payload: { ok: true },
	});
	const actions: ActionAdapter = {
		executeInTransaction: (_tx, request) => {
			seen.push({
				adapterRef: request.adapterRef,
				operationName: request.operationName,
				requestId: request.requestId,
			});
			return envelope(request.adapterRef, `op-${request.requestId}`);
		},
		readInTransaction: (_tx, operationId, _owner, adapterRef) => {
			reads.push(adapterRef);
			return envelope(adapterRef, operationId);
		},
	};
	const tools = createToolRuntime(
		store,
		caps,
		queue,
		{
			startInTransaction: () => ({ operationId: "o", jobId: "j" }),
			get: () => null,
			cancelInTransaction: () => [],
		},
		Date.now,
		actions,
	);
	try {
		await caps.seed();
		const owner = { rootRunId: "root", taskId: "task", cancelEpoch: 0 };
		const deadline = Date.now() + 60_000;
		const binding = {
			adapterRef: "adapter:fake@1",
			operationName: "fake.start",
		};
		const first = await store.write((db) => {
			const prepared = caps.prepareActiveByIdInTransaction(
				db,
				owner,
				"package:timers.manage@2",
				{ operation: "start", durationSeconds: 90 },
			);
			const start = tools
				.bind(owner, prepared, deadline)
				.find((r) => r.tool.id === "timer.start")!;
			return tools.invokeActionInTransaction(
				db,
				owner,
				start.executionRef,
				{ durationSeconds: 90 },
				"step-1",
				deadline,
				"origin",
				binding,
			);
		});
		expect(seen).toEqual([{ ...binding, requestId: seen[0]!.requestId }]);
		expect(first.adapterRef).toBe("adapter:fake@1");
		const stored = store.read((db) =>
			db
				.query(
					"SELECT adapter_ref,operation_name FROM tool_action_invocations WHERE id=?",
				)
				.get(first.invocationId),
		);
		expect(stored).toEqual({
			adapter_ref: "adapter:fake@1",
			operation_name: "fake.start",
		});

		// A repeated step replays through the stored adapter without a second execution.
		const again = await store.write((db) => {
			const prepared = caps.prepareActiveByIdInTransaction(
				db,
				owner,
				"package:timers.manage@2",
				{ operation: "start", durationSeconds: 90 },
			);
			const start = tools
				.bind(owner, prepared, deadline)
				.find((r) => r.tool.id === "timer.start")!;
			return tools.invokeActionInTransaction(
				db,
				owner,
				start.executionRef,
				{ durationSeconds: 90 },
				"step-1",
				deadline,
				"origin",
				binding,
			);
		});
		expect(seen).toHaveLength(1);
		expect(again.invocationId).toBe(first.invocationId);
		// The same step with another binding is an idempotency conflict.
		await expect(
			store.write((db) => {
				const prepared = caps.prepareActiveByIdInTransaction(
					db,
					owner,
					"package:timers.manage@2",
					{ operation: "start", durationSeconds: 90 },
				);
				const start = tools
					.bind(owner, prepared, deadline)
					.find((r) => r.tool.id === "timer.start")!;
				return tools.invokeActionInTransaction(
					db,
					owner,
					start.executionRef,
					{ durationSeconds: 90 },
					"step-1",
					deadline,
					"origin",
					{ ...binding, operationName: "fake.other" },
				);
			}),
		).rejects.toThrow("idempotency_conflict");
		const read = store.read((db) =>
			tools.readActionInTransaction(db, owner, first.invocationId),
		);
		expect(read.adapterRef).toBe("adapter:fake@1");
		expect(reads.at(-1)).toBe("adapter:fake@1");
	} finally {
		await store.close();
	}
});
