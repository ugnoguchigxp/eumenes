/** A disposable host process. Only the parent-supplied temporary directory is used. */
import { readFileSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { CONTRACT_VERSIONS } from "eumenes-memory";
import {
	applyForget,
	getForgetReceipt,
	planForget,
	type ForgetJournalEntry,
} from "eumenes-memory/sqlite";
import { createContinuityService } from "../../domains/continuity";
import { createConversationService } from "../../domains/conversation";
import { createMemoryService } from "../../domains/memory";
import { appendJournal } from "../../domains/memory/test/journal.fixture";
import {
	createWorldHostGate,
	createWorldLifecycle,
	createConversationSourceAdapter,
} from "../../domains/world";
import { createWorldFixture } from "../../domains/world/test/usage.fixture";
import {
	ACCESS,
	SCOPE,
	NOW,
	PURPOSE,
	TEST_CURSOR_SECRET,
	memoryPolicyRevision,
	claim,
	currentRef,
	entityOp,
	registerClaim,
	request,
	adoptPlan,
	keyOf,
} from "../../domains/world/test/fixture";
import { migrations } from "../migrations";
import { openStore } from "../../infrastructure/sqlite";

async function run() {
	const [dir, mode, stop] = process.argv.slice(2);
	if (!dir || !mode) throw new Error("temporary directory and mode required");
	const checkpoint = (point: string) => {
		if (point !== stop) return;
		writeSync(1, `WORLD_CHECKPOINT:${point}\n`);
		// The parent sends SIGKILL. No exception unwinding, finally, or close is run.
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
	};
	const path = join(dir, "db.sqlite3");
	const store = openStore(path, migrations);
	const conversation = createConversationService(store, {
		requireOutbox: true,
	});
	const memory = createMemoryService(
		store,
		conversation,
		createContinuityService(),
		{
			journalPath: join(dir, "memory.jsonl"),
			clock: () => new Date(NOW).toISOString(),
		},
	);
	const gate = createWorldHostGate();
	const source = createConversationSourceAdapter(conversation, {
		allowedPurposes: [PURPOSE],
		cursorSecret: TEST_CURSOR_SECRET,
	});
	const world = createWorldFixture({
		store,
		sources: [source],
		policyRevision: memoryPolicyRevision,
		gate,
	});
	const lifecycle = createWorldLifecycle({
		store,
		world,
		gate,
		sources: [source],
		scopes: [SCOPE],
		purpose: PURPOSE,
		clock: () => NOW,
		journalPath: join(dir, "world.jsonl"),
		maxChunksPerCall: 1,
		confirmBatch: 1,
		hook: checkpoint,
	});
	try {
		if (mode === "init") {
			await memory.recover();
			await lifecycle.recoverWorld();
			await world.markInitialSyncComplete();
			await world.setEnabled(true);
			for (const id of ["erase", "keep"])
				await conversation.append({
					id,
					conversationId: "c1",
					role: "user",
					text: `本文-${id}`,
					createdAt: "2026-10-09T00:00:00.000Z",
					runId: null,
				});
			const h = { store, conversation };
			for (const result of [
				await world.apply(entityOp()),
				...(await Promise.all(
					["erase", "keep"].map((id) =>
						world.apply(
							registerClaim(`register-${id}`, claim(id, [currentRef(h, id)])),
						),
					),
				)),
			])
				if (result.status !== "applied")
					throw new Error(JSON.stringify(result));
			for (const id of ["erase", "keep"]) {
				const result = await world.apply(
					request(`adopt-${id}`, {
						kind: "assertion.transition",
						plan: adoptPlan(id, 1),
					}),
				);
				if (result.status !== "applied")
					throw new Error(JSON.stringify(result));
			}
			await lifecycle.consumeSourceChanges(SCOPE);
			const entry = await store.write((db) => {
				const plan = planForget(db, {
					contractVersion: CONTRACT_VERSIONS.lifecycle,
					access: { ...ACCESS, policyRevision: memoryPolicyRevision(db) },
					target: {
						type: "host_source",
						sourceKey: keyOf("erase"),
						scopeKey: SCOPE.scopeKey,
					},
					clock: { atMs: NOW },
				});
				if (plan.status !== "planned") throw new Error(JSON.stringify(plan));
				return plan.plan.entry;
			});
			writeFileSync(join(dir, "entry.json"), JSON.stringify(entry));
		} else {
			const recoveredMemory = await memory.recover();
			if (!recoveredMemory.healthy)
				throw new Error(JSON.stringify(recoveredMemory));
			if (gate.isOpen()) throw new Error("startup gate opened before recovery");
			const recovered = await lifecycle.recoverWorld({
				memoryFeedResyncRequired: recoveredMemory.feedResyncRequired === true,
			});
			if (recovered.status !== "open")
				throw new Error(JSON.stringify(recovered));
			const entry = JSON.parse(
				readFileSync(join(dir, "entry.json"), "utf8"),
			) as ForgetJournalEntry;
			if (mode === "run" || mode === "replay-memory")
				await store.write((db) => {
					appendJournal(join(dir, "memory.jsonl"), entry);
					checkpoint("memory_journal_appended");
					applyForget(db, {
						contractVersion: CONTRACT_VERSIONS.lifecycle,
						entry,
						clock: { atMs: NOW },
					});
				});
			if (mode === "replay-memory") {
				await memory.recover();
				await lifecycle.recoverWorld({ memoryFeedResyncRequired: true });
			}
			const result = await lifecycle.acceptForget({
				forgetId: "host-process-forget",
				memoryForgetId: entry.forgetId,
				scope: SCOPE,
				reasonCode: "SOURCE_FORGOTTEN",
				roots: [
					{ kind: "source", id: keyOf("erase") },
					...Array.from({ length: 1001 }, (_, i) => ({
						kind: "source" as const,
						id: `absent-${i}`,
					})),
				],
			});
			if (!("complete" in result) || !result.complete)
				throw new Error(JSON.stringify(result));
			await lifecycle.consumeMemoryChanges(SCOPE);
			await lifecycle.consumeSourceChanges(SCOPE);
			const snapshot = store.read((db) => {
				const receipt = getForgetReceipt(db, {
					contractVersion: CONTRACT_VERSIONS.lifecycle,
					access: { ...ACCESS, policyRevision: memoryPolicyRevision(db) },
					forgetId: entry.forgetId,
				});
				return {
					gate: gate.isOpen(),
					assertions: db
						.query(
							"SELECT id,revision,lifecycle FROM world_assertion ORDER BY id",
						)
						.all(),
					projection: db
						.query(
							"SELECT assertion_id,assertion_revision,lifecycle,payload_json FROM world_current ORDER BY assertion_id",
						)
						.all(),
					gates: db
						.query(
							"SELECT state,reason_code FROM world_scope_gate ORDER BY principal,scope_key",
						)
						.all(),
					tombstones: db
						.query("SELECT kind,id FROM world_tombstone ORDER BY kind,id")
						.all(),
					cursors: ["source", "memory"].map((feed) => {
						const c = world.feedCursor(db, feed as "source" | "memory", SCOPE);
						return { feed, cursor: c.cursor, stale: c.stale };
					}),
					externals:
						receipt.status === "found"
							? receipt.receipt.externalDeletions.map((e) => ({
									id: e.externalId,
									state: e.state,
								}))
							: null,
					pending: db
						.query(
							"SELECT count(*) AS n FROM world_host_forget_intake WHERE state != 'complete'",
						)
						.get(),
				};
			});
			writeSync(1, `WORLD_RESULT:${JSON.stringify(snapshot)}\n`);
		}
	} finally {
		await store.close();
	}
}
if (import.meta.main) await run();
