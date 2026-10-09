import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	assertMemorySchema,
	migrations as memoryPackageMigrations,
} from "eumenes-memory/sqlite";
import { openStore } from "../infrastructure/sqlite";
import { createHash } from "node:crypto";
import {
	createConversationService,
	outboxMigration as conversationOutboxMigration,
	retractionMigration as conversationRetractionMigration,
} from "../domains/conversation";
import { hostMigrations, migrations } from "./migrations";
import {
	migrations as worldPackageMigrations,
	readWorldSnapshot,
} from "eumenes-world-model/sqlite";
import {
	hostStateMigration as worldHostStateMigration,
	lifecycleMigration as worldLifecycleMigration,
	usageMigration as worldUsageMigration,
	guardMigration as worldGuardMigration,
	extractionMigration as worldExtractionMigration,
	runtimeMigration as worldRuntimeMigration,
	gapTaskMigration as worldGapTaskMigration,
} from "../domains/world";
import { worldStateMigration as dialogueWorldStateMigration } from "../domains/dialogue";
import { migration as codingMigration } from "../domains/coding";
import { migration as timersMigration } from "../domains/timers";
import { actionResultMigration as agentActionResultMigration } from "../domains/agent-runtime";
import { actionMigration as toolActionMigration } from "../domains/tool-runtime";
import { migration as serviceTestsMigration } from "../domains/service-tests";

test("the memory package's migrations keep their order and every one is applied; the first four stay contiguous", () => {
	expect(memoryPackageMigrations.length).toBeGreaterThan(0);
	// In order as a subsequence (a host migration may sit between package migrations only
	// where it already did when those package migrations were first deployed).
	let cursor = 0;
	for (const migration of memoryPackageMigrations) {
		const at = migrations.indexOf(migration, cursor);
		expect(at).toBeGreaterThanOrEqual(cursor);
		cursor = at + 1;
	}
	// The original block: the first four package migrations follow the host block directly.
	expect(
		migrations.slice(hostMigrations.length, hostMigrations.length + 4),
	).toEqual(memoryPackageMigrations.slice(0, 4));
	expect(migrations[hostMigrations.length + 4]).toBe(serviceTestsMigration);
	expect(migrations.slice(0, hostMigrations.length)).toEqual([
		...hostMigrations,
	]);
});

test("host migrations are append-only: the count and the retired slot never move", () => {
	// Raise this number only when appending a new host migration (and re-check the package block).
	expect(hostMigrations).toHaveLength(18);
	expect(hostMigrations[7]).toBe("SELECT 1");
});

test("a fresh database gets every migration and passes the memory schema check", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-migrations-"));
	try {
		const store = openStore(join(dir, "db.sqlite3"), migrations);
		store.read((db) => assertMemorySchema(db));
		await store.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("an applied migration that is rewritten later stops startup with its id only", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-checksum-"));
	try {
		const path = join(dir, "db.sqlite3");
		const original = [
			"CREATE TABLE a (x INTEGER)",
			"CREATE TABLE b (y INTEGER)",
		];
		const store = openStore(path, original);
		await store.close();
		const rewritten = [original[0]!, "CREATE TABLE b (y INTEGER, z TEXT)"];
		let error: unknown;
		try {
			openStore(path, rewritten);
		} catch (e) {
			error = e;
		}
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toBe("migration_checksum_mismatch");
		expect((error as { migrationId: number }).migrationId).toBe(2);
		expect(JSON.stringify(error)).not.toContain("CREATE TABLE");
		// The unchanged list still opens.
		const again = openStore(path, original);
		await again.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a database from before checksums is backfilled once and then verified", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-checksum-legacy-"));
	try {
		const path = join(dir, "db.sqlite3");
		const list = ["CREATE TABLE a (x INTEGER)", "CREATE TABLE b (y INTEGER)"];
		const legacy = new Database(path, { create: true });
		legacy.exec(
			"CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY); INSERT INTO schema_migrations (id) VALUES (1),(2);" +
				list.join(";"),
		);
		legacy.close();
		const store = openStore(path, list);
		const rows = store.read((db) =>
			db.query("SELECT id, checksum FROM schema_migrations ORDER BY id").all(),
		) as { id: number; checksum: string | null }[];
		expect(rows.map((r) => r.id)).toEqual([1, 2]);
		expect(rows.every((r) => /^[0-9a-f]{64}$/.test(r.checksum ?? ""))).toBe(
			true,
		);
		await store.close();
		expect(() =>
			openStore(path, [list[0]!, "CREATE TABLE b (y TEXT)"]),
		).toThrow("migration_checksum_mismatch");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("an existing 0.3.3 host database upgrades without rewriting migration checksums or losing data", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-web-upgrade-"));
	try {
		const path = join(dir, "db.sqlite3");
		const previous = [
			...hostMigrations,
			...memoryPackageMigrations.slice(0, 4),
			serviceTestsMigration,
		];
		const before = openStore(path, previous);
		await createConversationService(before).append({
			id: "fixture-message",
			conversationId: "fixture-conversation",
			role: "user",
			text: "preserved across upgrade",
			createdAt: "2026-10-09T00:00:00.000Z",
			runId: null,
		});
		const checksums = before.read((db) =>
			db.query("SELECT id,checksum FROM schema_migrations ORDER BY id").all(),
		);
		await before.close();
		const after = openStore(path, migrations);
		try {
			after.read((db) => assertMemorySchema(db));
			expect(
				createConversationService(after).get("fixture-conversation").messages[0]
					?.text,
			).toBe("preserved across upgrade");
			expect(
				after.read((db) =>
					db
						.query(
							"SELECT id,checksum FROM schema_migrations WHERE id<=? ORDER BY id",
						)
						.all(previous.length),
				),
			).toEqual(checksums);
			expect(
				after.read((db) =>
					db
						.query(
							"SELECT name FROM sqlite_master WHERE name IN ('memory_record_retention','web_research_runs') ORDER BY name",
						)
						.all(),
				),
			).toHaveLength(2);
		} finally {
			await after.close();
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

const seedRun = (db: Database, messageId: string, answerId: string | null) =>
	db
		.query(
			"INSERT INTO dialogue_runs (id,request_id,conversation_id,status,revision,input_message_id,answer_message_id,created_at,updated_at) VALUES ('run-1','req-1','fixture-conversation','completed',1,?,?,'2026-10-09T00:00:00.000Z','2026-10-09T00:00:00.000Z')",
		)
		.run(messageId, answerId);
const fixtureMessage = (
	id: string,
	role: "user" | "assistant",
	text: string,
) => ({
	id,
	conversationId: "fixture-conversation",
	role,
	text,
	createdAt: "2026-10-09T00:00:00.000Z",
	runId: null,
});
const outboxDump = (db: Database) =>
	JSON.stringify(db.query("SELECT * FROM conversation_outbox").all());

test("World source/goal migrations are appended last and upgrade an already-deployed database", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-world-upgrade-"));
	try {
		const path = join(dir, "db.sqlite3");
		// Everything deployed before the World migrations were appended.
		const deployed = migrations.slice(
			0,
			migrations.indexOf(conversationOutboxMigration),
		);
		expect(deployed.length).toBeGreaterThan(0);
		// Retraction and goal-operation columns come after everything deployed.
		expect(migrations.indexOf(conversationRetractionMigration)).toBeGreaterThan(
			migrations.indexOf(conversationOutboxMigration),
		);
		const before = openStore(path, deployed);
		await createConversationService(before).append(
			fixtureMessage("pre-1", "user", "kept across upgrade"),
		);
		await createConversationService(before).append(
			fixtureMessage("pre-2", "assistant", "answer kept"),
		);
		await before.write((db) => seedRun(db, "pre-1", "pre-2"));
		await before.close();
		const store = openStore(path, migrations);
		try {
			const tables = store.read((db) =>
				(
					db
						.query(
							"SELECT name FROM sqlite_master WHERE name IN ('conversation_outbox','goals_ledger')",
						)
						.all() as { name: string }[]
				).map((row) => row.name),
			);
			expect(tables.sort()).toEqual(["conversation_outbox", "goals_ledger"]);
			const service = createConversationService(store, {
				requireOutbox: true,
			});
			// Data intact after the upgrade.
			expect(
				service.get("fixture-conversation").messages.map((m) => m.text),
			).toEqual(["kept across upgrade", "answer kept"]);
			expect(
				store.read((db) =>
					db
						.query(
							"SELECT input_message_id, answer_message_id FROM dialogue_runs",
						)
						.all(),
				),
			).toEqual([{ input_message_id: "pre-1", answer_message_id: "pre-2" }]);
			// Correct and retract work on a message that predates the outbox.
			expect(
				await service.correct({ messageId: "pre-1", text: "corrected" }),
			).toMatchObject({ status: "applied", kind: "corrected" });
			expect(service.get("fixture-conversation").messages[0]?.text).toBe(
				"corrected",
			);
			expect(await service.retract({ messageId: "pre-1" })).toMatchObject({
				status: "applied",
				kind: "retracted",
			});
			expect(
				service.get("fixture-conversation").messages.map((m) => m.id),
			).toEqual(["pre-2"]);
			expect(
				store.read((db) =>
					db.query("SELECT input_message_id FROM dialogue_runs").all(),
				),
			).toEqual([{ input_message_id: "pre-1" }]);
		} finally {
			await store.close();
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("with the full production migrations, retracting a message referenced by a dialogue run tombstones it", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-retract-prod-"));
	try {
		const store = openStore(join(dir, "db.sqlite3"), migrations);
		try {
			const service = createConversationService(store, {
				requireOutbox: true,
			});
			await service.append(fixtureMessage("in-1", "user", "secret input"));
			await service.append(
				fixtureMessage("out-1", "assistant", "secret answer"),
			);
			await store.write((db) => seedRun(db, "in-1", "out-1"));
			expect(store.read((db) => db.query("PRAGMA foreign_keys").get())).toEqual(
				{ foreign_keys: 1 },
			);
			// The scrubbed digests: a correction first, then the retraction.
			await service.correct({ messageId: "in-1", text: "secret input v2" });
			const result = await service.retract({ messageId: "in-1" });
			expect(result).toMatchObject({ status: "applied", kind: "retracted" });
			// The dialogue run is intact and still points at the tombstoned row.
			expect(
				store.read((db) =>
					db
						.query(
							"SELECT input_message_id, answer_message_id, status FROM dialogue_runs",
						)
						.all(),
				),
			).toEqual([
				{
					input_message_id: "in-1",
					answer_message_id: "out-1",
					status: "completed",
				},
			]);
			// Invisible to every conversation read (and so to memory/dialogue).
			expect(
				service.get("fixture-conversation").messages.map((m) => m.id),
			).toEqual(["out-1"]);
			expect(
				store.read((db) => service.messageInTransaction(db, "in-1")),
			).toBeNull();
			expect(
				store
					.read((db) =>
						service.messagesInTransaction(db, "fixture-conversation"),
					)
					.map((m) => m.id),
			).toEqual(["out-1"]);
			expect(
				store.read((db) => service.sourceInTransaction(db, "in-1")),
			).toMatchObject({ state: "retracted" });
			expect(
				store.read((db) => service.sourceInTransaction(db, "out-1")),
			).toMatchObject({ state: "available" });
			// The stored text is blanked in place.
			expect(
				store.read((db) =>
					db
						.query("SELECT text, retracted_at FROM messages WHERE id='in-1'")
						.get(),
				),
			).toMatchObject({ text: "" });
			// Outbox: retraction recorded, no digest or text of the removed message left.
			const events = store.read((db) =>
				service.changesInTransaction(db, 0, 100),
			);
			expect(
				events.filter((e) => e.sourceId === "in-1").map((e) => e.kind),
			).toEqual(["added", "corrected", "retracted"]);
			const dump = store.read(outboxDump);
			for (const text of ["secret input", "secret input v2"])
				expect(dump).not.toContain(
					createHash("sha256").update(text).digest("hex"),
				);
			expect(dump).not.toContain("secret");
			// A retracted id never comes back or gets corrected.
			await expect(
				service.append(fixtureMessage("in-1", "user", "again")),
			).rejects.toThrow("message_retracted");
			expect(await service.correct({ messageId: "in-1", text: "x" })).toEqual({
				status: "retracted",
			});
		} finally {
			await store.close();
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// ---- World package + host state (P3-06) ----

/** Everything deployed before the World package migrations were appended. */
const beforeWorld = () =>
	migrations.slice(0, migrations.indexOf(worldPackageMigrations[0] as string));
const worldProbe = (store: ReturnType<typeof openStore>) =>
	store.readSnapshot((db) => readWorldSnapshot(db, {}));

test("World's package migrations stay contiguous, and timers is appended after them", () => {
	expect(worldPackageMigrations.length).toBeGreaterThan(0);
	const worldStart = migrations.indexOf(worldPackageMigrations[0] as string);
	expect(
		migrations.slice(
			worldStart,
			worldStart + worldPackageMigrations.length + 3,
		),
	).toEqual([
		...worldPackageMigrations,
		worldHostStateMigration,
		worldLifecycleMigration,
		worldUsageMigration,
	]);
	expect(migrations[worldStart + worldPackageMigrations.length + 3]).toBe(
		timersMigration,
	);
	expect(migrations[worldStart + worldPackageMigrations.length + 4]).toBe(
		agentActionResultMigration,
	);
	expect(migrations[worldStart + worldPackageMigrations.length + 5]).toBe(
		toolActionMigration,
	);
	expect(migrations[worldStart + worldPackageMigrations.length + 6]).toBe(
		codingMigration,
	);
	// World hardening is appended at the tail, after everything deployed before it.
	expect(migrations[worldStart + worldPackageMigrations.length + 7]).toBe(
		worldGuardMigration,
	);
	// World answer release (P3-08) is the very tail.
	expect(migrations[worldStart + worldPackageMigrations.length + 8]).toBe(
		dialogueWorldStateMigration,
	);
	// World continuous input (P4-01/P4-02) is appended after everything deployed before it,
	// including whatever else was appended after the answer release.
	expect(migrations.filter((m) => m === worldExtractionMigration)).toHaveLength(
		1,
	);
	expect(migrations.indexOf(worldExtractionMigration)).toBeGreaterThan(
		migrations.indexOf(dialogueWorldStateMigration),
	);
	// World runtime observation (P4-04) follows the extraction record.
	expect(migrations.filter((m) => m === worldRuntimeMigration)).toHaveLength(1);
	expect(migrations.indexOf(worldRuntimeMigration)).toBe(
		migrations.indexOf(worldExtractionMigration) + 1,
	);
	// World decision API (P5-01) is the very tail, right after the runtime observation.
	expect(migrations.filter((m) => m === worldGapTaskMigration)).toHaveLength(1);
	expect(migrations.indexOf(worldGapTaskMigration)).toBe(
		migrations.indexOf(worldRuntimeMigration) + 1,
	);
	expect(migrations.at(-1)).toBe(worldGapTaskMigration);
	// Nothing that was already deployed moved: the prefix is unchanged and contiguous.
	expect(beforeWorld().length).toBe(worldStart);
	expect(beforeWorld()).toContain(conversationRetractionMigration);
	// The retired slot and the host block stay where they were.
	expect(migrations.slice(0, hostMigrations.length)).toEqual([
		...hostMigrations,
	]);
});

test("a fresh database gets the World schema; World is OFF and its schema is current", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-world-fresh-"));
	try {
		const store = openStore(join(dir, "db.sqlite3"), migrations);
		try {
			const names = store.read((db) =>
				(
					db
						.query(
							"SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE 'world\\_%' ESCAPE '\\') ORDER BY name",
						)
						.all() as { name: string }[]
				).map((row) => row.name),
			);
			expect(names).toEqual(
				expect.arrayContaining([
					"world_schema_info",
					"world_assertion",
					"world_host_state",
					"world_host_forget_epoch",
					"world_host_feed_cursor",
					"world_host_forget_intake",
					"world_host_forget_confirmation",
					"world_host_dependent",
					"world_host_restore",
					"world_host_usage",
					"world_host_forget_abandoned",
				]),
			);
			expect(
				store.read((db) =>
					db.query("SELECT enabled, restore_epoch FROM world_host_state").all(),
				),
			).toEqual([{ enabled: 0, restore_epoch: "restore-0" }]);
			// World stays OFF and cannot be switched ON before the host's initial sync.
			expect(
				store.read((db) =>
					db
						.query("SELECT initial_sync_complete AS n FROM world_host_state")
						.get(),
				),
			).toEqual({ n: 0 });
			// Current schema: an empty request reaches World's own parser and is rejected there.
			expect(worldProbe(store)).toMatchObject({
				status: "rejected",
				reasonCode: "INVALID_INPUT",
			});
		} finally {
			await store.close();
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("an already-deployed database (data present, no World yet) upgrades and keeps its data", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-world-existing-"));
	try {
		const path = join(dir, "db.sqlite3");
		const previous = beforeWorld();
		expect(previous.length).toBeGreaterThan(0);
		const before = openStore(path, previous);
		const service = createConversationService(before, { requireOutbox: true });
		await service.append(
			fixtureMessage("keep-1", "user", "kept across World upgrade"),
		);
		await service.append(fixtureMessage("keep-2", "assistant", "answer kept"));
		await before.write((db) => seedRun(db, "keep-1", "keep-2"));
		const checksums = before.read((db) =>
			db.query("SELECT id, checksum FROM schema_migrations ORDER BY id").all(),
		);
		await before.close();
		const after = openStore(path, migrations);
		try {
			// Earlier migration records are untouched; World's are appended.
			expect(
				after.read((db) =>
					db
						.query(
							"SELECT id, checksum FROM schema_migrations WHERE id <= ? ORDER BY id",
						)
						.all(previous.length),
				),
			).toEqual(checksums);
			expect(
				after.read(
					(db) =>
						(
							db.query("SELECT COUNT(*) AS n FROM schema_migrations").get() as {
								n: number;
							}
						).n,
				),
			).toBe(migrations.length);
			const reread = createConversationService(after, { requireOutbox: true });
			expect(
				reread.get("fixture-conversation").messages.map((m) => m.text),
			).toEqual(["kept across World upgrade", "answer kept"]);
			expect(
				after.read((db) =>
					db
						.query(
							"SELECT input_message_id, answer_message_id FROM dialogue_runs",
						)
						.all(),
				),
			).toEqual([{ input_message_id: "keep-1", answer_message_id: "keep-2" }]);
			expect(worldProbe(after)).toMatchObject({ status: "rejected" });
			expect(
				after.read((db) =>
					db.query("SELECT enabled FROM world_host_state WHERE id = 1").get(),
				),
			).toEqual({ enabled: 0 });
		} finally {
			await after.close();
		}
		// Reopening is idempotent: nothing is re-applied.
		const again = openStore(path, migrations);
		await again.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a drifted World schema disables World; an edited World migration stops startup", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-world-drift-"));
	try {
		const path = join(dir, "db.sqlite3");
		const store = openStore(path, migrations);
		await store.write((db) => {
			db.query("UPDATE world_schema_info SET sha256 = ? WHERE ordinal = 1").run(
				"f".repeat(64),
			);
		});
		// World refuses (blocked, no World table touched); the host keeps running.
		expect(worldProbe(store)).toEqual({
			status: "blocked",
			reasonCode: "SCHEMA_INCOMPATIBLE",
		});
		await createConversationService(store).append(
			fixtureMessage("alive", "user", "host still works"),
		);
		await store.close();
		// The host's own checksum guard: an edited World migration is refused at open.
		const index = migrations.indexOf(worldPackageMigrations[1] as string);
		const edited = migrations.map((sql, i) =>
			i === index ? `${sql}\n-- edited` : sql,
		);
		let error: unknown;
		try {
			openStore(path, edited);
		} catch (e) {
			error = e;
		}
		expect((error as Error).message).toBe("migration_checksum_mismatch");
		expect((error as { migrationId: number }).migrationId).toBe(index + 1);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
