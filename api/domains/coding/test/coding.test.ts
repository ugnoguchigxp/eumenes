import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { sha256Hex } from "../../../infrastructure/digest";
import { canonicalJSON } from "../../../../packages/coding-runner/src/contracts";
import { openStore, type SqliteStore } from "../../../infrastructure/sqlite";
import { createCoding } from "../service";
import { migration } from "../repository";
import { connectRunner } from "../../../../packages/coding-runner/src/client";
import {
	createRunner,
	publishSpec,
} from "../../../../packages/coding-runner/src/core";
import {
	fixture,
	until,
} from "../../../../packages/coding-runner/test/support";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
});
async function setup(now?: () => number) {
	const f = fixture();
	cleanup.push(f.close);
	const store: SqliteStore = openStore(join(f.root, "test.sqlite"), [
		migration,
	]);
	cleanup.push(() => store.close());
	const runner = await connectRunner({
		executable: process.execPath,
		serverPath: join(
			import.meta.dir,
			"../../../../packages/coding-runner/test/fixture-server.ts",
		),
		configPath: f.configPath,
	});
	cleanup.push(() => runner.close());
	const coding = createCoding({
		store,
		now,
		runner,
		publishSpec: (ref, spec) => publishSpec(f.config, ref, spec),
	});
	await store.write((db) =>
		coding.registerWorkspaceInTransaction(db, {
			id: "fixture",
			branch: "codex/fixture",
			available: true,
			reason: null,
		}),
	);
	const authority = {
		taskId: "task",
		generation: 1,
		authorityEpoch: 1,
		workspaceId: "fixture",
		branch: "codex/fixture",
		operations: ["read", "edit"] as ["read", "edit"],
		network: "none" as const,
		deadlineAt: Date.now() + 30000,
	};
	return { f, store, runner, coding, authority };
}
describe("coding domain", () => {
	test("intent and reservation rollback together; duplicate operations never create another execution", async () => {
		const { store, coding, authority } = await setup();
		const operationId = crypto.randomUUID();
		await expect(
			store.write((db) => {
				coding.prepareInTransaction(db, authority, {
					operationId,
					instruction: "normal",
					kind: "implement",
				});
				throw new Error("rollback");
			}),
		).rejects.toThrow("rollback");
		const prepared = await store.write((db) =>
			coding.prepareInTransaction(db, authority, {
				operationId,
				instruction: "normal",
				kind: "implement",
			}),
		);
		const duplicate = await store.write((db) =>
			coding.prepareInTransaction(
				db,
				Object.fromEntries(
					Object.entries(authority).reverse(),
				) as typeof authority,
				{
					kind: "implement",
					operationId,
					instruction: "normal",
					previousExecutionId: undefined,
				},
			),
		);
		expect(duplicate).toEqual(prepared);
		await expect(
			store.write((db) =>
				coding.prepareInTransaction(db, authority, {
					operationId,
					instruction: "different",
					kind: "implement",
				}),
			),
		).rejects.toThrow("coding_operation_conflict");
		await expect(
			store.write((db) =>
				coding.prepareInTransaction(db, authority, {
					operationId: crypto.randomUUID(),
					instruction: "normal",
					kind: "implement",
				}),
			),
		).rejects.toThrow("coding_workspace_busy");
	});
	test("cursor and event adoption are atomic; duplicates, gaps and changed digests are checked", async () => {
		const { store, coding, authority } = await setup();
		const p = await store.write((db) =>
			coding.prepareInTransaction(db, authority, {
				operationId: crypto.randomUUID(),
				instruction: "normal",
				kind: "implement",
			}),
		);
		await coding.dispatch(p);
		const batch = await until(
			() => coding.inspect(p.spec.executionId, 0, 100, false),
			(r) => r.receipt.childrenStopped,
		);
		await expect(
			store.write((db) => {
				coding.adoptInTransaction(db, authority, batch);
				throw new Error("rollback");
			}),
		).rejects.toThrow("rollback");
		expect(coding.get(p.spec.executionId).cursor).toBe(0);
		await store.write((db) => coding.adoptInTransaction(db, authority, batch));
		await store.write((db) => coding.adoptInTransaction(db, authority, batch));
		expect(coding.events(p.spec.executionId).events).toHaveLength(5);
		const corrupt = structuredClone(batch);
		corrupt.events[0]!.payloadDigest = "0".repeat(64);
		await expect(
			store.write((db) => coding.adoptInTransaction(db, authority, corrupt)),
		).rejects.toThrow("coding_event_digest_conflict");
		expect(coding.get(p.spec.executionId).cursor).toBe(5);
	});
	test("old authority cannot adopt output; confirmed stop remains usable after grant expiration", async () => {
		const { store, coding, authority } = await setup();
		const p = await store.write((db) =>
			coding.prepareInTransaction(db, authority, {
				operationId: crypto.randomUUID(),
				instruction: "normal",
				kind: "implement",
			}),
		);
		await coding.dispatch(p);
		const batch = await until(
			() => coding.inspect(p.spec.executionId, 0, 100),
			(r) => r.receipt.childrenStopped,
		);
		await expect(
			store.write((db) =>
				coding.adoptInTransaction(
					db,
					{ ...authority, authorityEpoch: 2 },
					batch,
				),
			),
		).rejects.toThrow("coding_authority_stale");
		await expect(
			store.write((db) =>
				coding.adoptInTransaction(db, { ...authority, deadlineAt: 1 }, batch),
			),
		).rejects.toThrow("coding_authority_stale");
		await store.write((db) =>
			coding.confirmStoppedInTransaction(db, "task", 1, batch.receipt),
		);
		expect(coding.get(p.spec.executionId).childrenStopped).toBe(true);
	});
	test("recovery preserves intent and reservation without replaying start", async () => {
		const { store, coding, authority, f } = await setup();
		const p = await store.write((db) =>
			coding.prepareInTransaction(db, authority, {
				operationId: crypto.randomUUID(),
				instruction: "normal",
				kind: "implement",
			}),
		);
		await coding.recover();
		expect(coding.get(p.spec.executionId).state).toBe("outcome_unknown");
		const runner = createRunner(f.configPath, true);
		expect(() => runner.inspect(p.spec.executionId, 0, 100, false)).toThrow();
		await expect(
			store.write((db) =>
				coding.prepareInTransaction(db, authority, {
					operationId: crypto.randomUUID(),
					instruction: "normal",
					kind: "implement",
				}),
			),
		).rejects.toThrow("coding_workspace_busy");
	});
	test("gap cannot advance a zero cursor", async () => {
		const { store, coding, authority } = await setup();
		const p = await store.write((db) =>
			coding.prepareInTransaction(db, authority, {
				operationId: crypto.randomUUID(),
				instruction: "normal",
				kind: "implement",
			}),
		);
		await coding.dispatch(p);
		const batch = await until(
			() => coding.inspect(p.spec.executionId, 0, 100),
			(r) => r.receipt.childrenStopped,
		);
		await expect(
			store.write((db) =>
				coding.adoptInTransaction(db, authority, {
					...batch,
					events: batch.events.slice(1),
				}),
			),
		).rejects.toThrow("coding_event_gap");
		expect(coding.get(p.spec.executionId).cursor).toBe(0);
	});
	test("public view hides session and instruction", async () => {
		const { store, coding, authority } = await setup();
		const p = await store.write((db) =>
			coding.prepareInTransaction(db, authority, {
				operationId: crypto.randomUUID(),
				instruction: "private task",
				kind: "implement",
			}),
		);
		const view = JSON.stringify(coding.get(p.spec.executionId));
		expect(view).not.toContain("private task");
		expect(view).not.toContain("sessionId");
		expect(view).not.toContain("nonce");
	});
});

test("receipt flags and state cannot regress after completion, and continuation waits for imported evidence", async () => {
	const { store, coding, authority } = await setup();
	const p = await store.write((db) =>
		coding.prepareInTransaction(db, authority, {
			operationId: crypto.randomUUID(),
			instruction: "normal",
			kind: "implement",
		}),
	);
	await coding.dispatch(p);
	const b = await until(
		() => coding.inspect(p.spec.executionId, 0, 100),
		(b) => b.receipt.childrenStopped,
	);
	await store.write((db) =>
		coding.acceptInTransaction(db, authority, b.receipt),
	);
	await expect(
		store.write((db) =>
			coding.prepareInTransaction(db, authority, {
				operationId: crypto.randomUUID(),
				instruction: "continue",
				kind: "continue",
				previousExecutionId: p.spec.executionId,
			}),
		),
	).rejects.toThrow("coding_workspace_busy");
	for (const r of [
		{ ...b.receipt, state: "running" as const, childrenStopped: false },
		{ ...b.receipt, turnFinished: false },
	])
		await expect(
			store.write((db) => coding.acceptInTransaction(db, authority, r)),
		).rejects.toThrow("coding_receipt_stale");
	await store.write((db) => coding.adoptInTransaction(db, authority, b));
	const next = await store.write((db) =>
		coding.prepareInTransaction(db, authority, {
			operationId: crypto.randomUUID(),
			instruction: "continue",
			kind: "continue",
			previousExecutionId: p.spec.executionId,
		}),
	);
	expect(next.spec.sessionId).toBe(b.receipt.sessionId);
});
test("an unchanged epoch cannot extend the execution deadline or replace network and operation authority", async () => {
	let now = Date.now();
	const { store, coding, authority } = await setup(() => now);
	const p = await store.write((db) =>
		coding.prepareInTransaction(db, authority, {
			operationId: crypto.randomUUID(),
			instruction: "normal",
			kind: "implement",
		}),
	);
	await coding.dispatch(p);
	const b = await until(
		() => coding.inspect(p.spec.executionId, 0, 100),
		(b) => b.receipt.childrenStopped,
	);
	for (const changed of [
		{ ...authority, network: "registered" as const },
		{ ...authority, operations: ["read", "push"] as ["read", "push"] },
	])
		await expect(
			store.write((db) => coding.adoptInTransaction(db, changed, b)),
		).rejects.toThrow("coding_authority_stale");
	now = authority.deadlineAt + 1;
	await expect(
		store.write((db) =>
			coding.adoptInTransaction(
				db,
				{ ...authority, deadlineAt: now + 60000 },
				b,
			),
		),
	).rejects.toThrow("coding_authority_stale");
});
async function finished() {
	const h = await setup();
	const p = await h.store.write((db) =>
		h.coding.prepareInTransaction(db, h.authority, {
			operationId: crypto.randomUUID(),
			instruction: "normal",
			kind: "implement",
		}),
	);
	await h.coding.dispatch(p);
	const batch = await until(
		() => h.coding.inspect(p.spec.executionId, 0, 100, false),
		(r) => r.receipt.childrenStopped && r.receipt.state === "exited",
	);
	return { ...h, p, batch };
}
test("the observation snapshot exposes adopted facts only, with message metadata", async () => {
	const { store, coding, authority, p, batch } = await finished();
	await store.write((db) => coding.adoptInTransaction(db, authority, batch));
	const s = store.readSnapshot((db) =>
		coding.observationSnapshotInTransaction(db, "task"),
	);
	expect(s.legacy).toBe(false);
	expect(s.cursor).toBe(batch.receipt.seq);
	expect(s.execution.observation).toMatchObject({
		turnOutcome: "completed",
		processStarted: true,
		captureState: "complete",
	});
	expect(s.messages[0]?.message).toMatchObject({
		messageKind: "unknown",
		classificationReason: "phase_not_provided",
	});
	expect(s.fileChange?.kind).toBe("file_changed");
	expect(s.execution.id).toBe(p.spec.executionId);
});
test("terminal facts cannot be retracted, flipped or pointed at a non-terminal event", async () => {
	const { store, coding, authority, batch } = await finished();
	await store.write((db) => coding.adoptInTransaction(db, authority, batch));
	const r = batch.receipt;
	const variants = [
		{
			...r,
			observation: {
				...r.observation,
				turnOutcome: "unconfirmed" as const,
				terminalEventSeq: null,
			},
		},
		{
			...r,
			observation: { ...r.observation, processStarted: false as const },
		},
	];
	for (const v of variants)
		await expect(
			store.write((db) => coding.acceptInTransaction(db, authority, v)),
		).rejects.toThrow(/coding_receipt_(stale|conflict)/);
	const wrongSeq = structuredClone(batch);
	wrongSeq.receipt.observation.terminalEventSeq = 1;
	await expect(
		store.write((db) => coding.adoptInTransaction(db, authority, wrongSeq)),
	).rejects.toThrow("coding_receipt_conflict");
});
test("a v1 session stays viewable but is never continued, with a fixed code", async () => {
	const { store, coding, authority, p, batch } = await finished();
	await store.write((db) => {
		coding.adoptInTransaction(db, authority, batch);
		const legacy = { ...p.spec, version: "eumenes-coding/1" };
		db.query("UPDATE coding_executions SET spec_json=? WHERE id=?").run(
			JSON.stringify(legacy),
			p.spec.executionId,
		);
	});
	const legacy = store.readSnapshot((db) =>
		coding.observationSnapshotInTransaction(db, "task"),
	);
	expect(legacy.legacy).toBe(true);
	// Proven normal end projects to completed; the process start and capture stay unknown.
	expect(legacy.execution.observation).toMatchObject({
		turnOutcome: "completed",
		terminalEventSeq: expect.any(Number),
	});
	await expect(
		store.write((db) =>
			coding.prepareInTransaction(db, authority, {
				operationId: crypto.randomUUID(),
				instruction: "continue",
				kind: "continue",
				previousExecutionId: p.spec.executionId,
			}),
		),
	).rejects.toThrow("coding_legacy_continue_unsupported");
});
test("a finished v1 execution (no observation on its receipt) is adopted, stopped and projected, never started", async () => {
	const { store, coding, authority, p, batch } = await finished();
	const legacy = { ...p.spec, version: "eumenes-coding/1" as const };
	await store.write((db) =>
		db
			.query("UPDATE coding_executions SET spec_json=? WHERE id=?")
			.run(JSON.stringify(legacy), p.spec.executionId),
	);
	// What a v1 runner wrote: the v1 spec digest, a normal end, and no observation at all.
	const receipt = {
		...batch.receipt,
		specDigest: sha256Hex(canonicalJSON(legacy)),
	} as Record<string, unknown>;
	delete receipt.observation;
	const view = await store.write((db) =>
		coding.adoptInTransaction(db, authority, { ...batch, receipt }),
	);
	expect(view.turnFinished).toBe(true);
	expect(view.observation).toMatchObject({
		turnOutcome: "completed",
		processStarted: "unknown",
	});
	const prepared = store.read((db) =>
		coding.preparedInTransaction(db, p.spec.operationId),
	);
	expect(prepared.spec.version).toBe("eumenes-coding/1");
	await expect(coding.dispatch(prepared)).rejects.toThrow(
		"runner_protocol_mismatch",
	);
	await store.write((db) =>
		coding.confirmStoppedInTransaction(
			db,
			"task",
			1,
			receipt as unknown as typeof batch.receipt,
		),
	);
});
test("a conflicting terminal is adopted as a conflict, not rejected as inconsistent", async () => {
	const { store, coding, authority, p } = await (async () => {
		const h = await setup();
		const p = await h.store.write((db) =>
			h.coding.prepareInTransaction(db, h.authority, {
				operationId: crypto.randomUUID(),
				instruction: "conflict",
				kind: "implement",
			}),
		);
		await h.coding.dispatch(p);
		return { ...h, p };
	})();
	const batch = await until(
		() => coding.inspect(p.spec.executionId, 0, 100, false),
		(r) => r.receipt.childrenStopped && r.receipt.state !== "stopping",
	);
	expect(batch.receipt.observation.turnOutcome).toBe("conflict");
	const view = await store.write((db) =>
		coding.adoptInTransaction(db, authority, batch),
	);
	expect(view.observation.turnOutcome).toBe("conflict");
	expect(view.evidenceComplete).toBe(false);
});
