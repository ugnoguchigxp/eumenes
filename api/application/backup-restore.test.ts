import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	applyForget,
	planForget,
	readForgetJournalHead,
	searchState,
	verifyStateSearchIndex,
	type ForgetJournalEntry,
} from "eumenes-memory/sqlite";
import { appendJournal, readJournal } from "../domains/memory/service/journal";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	renameSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { openStore } from "../infrastructure/sqlite";
import { createSettings } from "../domains/settings";
import { migrations } from "./migrations";
import { loadConfig } from "../infrastructure/config";
import { buildServices } from "./server-services";
import { createLifecycles } from "./server-lifecycles";
import { createLifecycleRunner } from "./lifecycle";
import { backupDatabaseOnRequest } from "./db-backup";

const close = (services: Awaited<ReturnType<typeof buildServices>>) =>
	createLifecycleRunner(
		createLifecycles(services, { name: "http", close: () => {} }),
	).closeAll(15_000);

test("offline backup restores history, encrypted fixture credentials and queued work; latest forget journal prevents resurrection", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-restore-drill-"));
	const sourceDir = join(dir, "source");
	const restoreDir = join(dir, "restored");
	mkdirSync(sourceDir);
	mkdirSync(restoreDir);
	const config = (folder: string) =>
		loadConfig({
			EUMENES_DB: join(folder, "db.sqlite3"),
			EUMENES_TOOLCHAIN_ENABLED: "0",
		});
	let source: Awaited<ReturnType<typeof buildServices>> | undefined;
	let restored: Awaited<ReturnType<typeof buildServices>> | undefined;
	try {
		source = await buildServices(config(sourceDir));
		const kept = crypto.randomUUID();
		const forgotten = crypto.randomUUID();
		await source.store.write((db) => {
			for (const [id, text] of [
				[kept, "復元後も残す試験発言"],
				[forgotten, "後で忘却する試験発言"],
			])
				source!.conversation.appendInTransaction(db, {
					id,
					conversationId: "main",
					role: "user",
					text,
					createdAt: new Date().toISOString(),
				} as never);
		});
		const settings = source.settings.get();
		const connectionId = crypto.randomUUID();
		settings.connections.push({
			id: connectionId,
			name: "復元試験専用",
			baseUrl: "https://example.test/v1",
			enabled: false,
			epoch: 0,
			envRef: null,
		});
		const saved = await source.settings.apply({
			requestId: crypto.randomUUID(),
			expectedRevision: settings.revision,
			settings,
			keys: [{ connectionId, value: "restore-fixture-credential" }],
		});
		const connection = saved.connections.find(
			(item) => item.id === connectionId,
		)!;
		const queued = await source.dialogue.submit({
			requestId: crypto.randomUUID(),
			conversationId: "restore-drill",
			text: "未着手の試験依頼",
		});
		expect(queued.status).toBe("queued");
		await expect(
			backupDatabaseOnRequest(join(sourceDir, "db.sqlite3")),
		).rejects.toThrow("database_writer_owned");
		await close(source);
		source = undefined;
		const { backupPath } = await backupDatabaseOnRequest(
			join(sourceDir, "db.sqlite3"),
		);
		mkdirSync(join(restoreDir, "keys"));
		copyFileSync(
			join(sourceDir, "keys/settings.key"),
			join(restoreDir, "keys/settings.key"),
		);
		copyFileSync(backupPath, join(restoreDir, "db.sqlite3"));
		// The backup predates this forget. Its durable journal must also accompany a restore.
		source = await buildServices(config(sourceDir));
		await source.memory.recover();
		await source.memory.forget({
			conversationId: "main",
			itemIds: [],
			messageIds: [forgotten],
		});
		// Retire real sidecars from a different generation before restoring its main file.
		for (const suffix of ["-wal", "-shm"]) {
			const stale = join(restoreDir, `db.sqlite3${suffix}`);
			copyFileSync(join(sourceDir, `db.sqlite3${suffix}`), stale);
			renameSync(stale, `${stale}.pre-restore`);
			expect(existsSync(stale)).toBe(false);
			expect(existsSync(`${stale}.pre-restore`)).toBe(true);
		}
		copyFileSync(backupPath, join(restoreDir, "db.sqlite3"));
		await close(source);
		source = undefined;
		const journal = "memory-forget-journal.jsonl";
		expect(existsSync(join(sourceDir, journal))).toBe(true);
		copyFileSync(join(sourceDir, journal), join(restoreDir, journal));
		restored = await buildServices(config(restoreDir));
		const recovery = await restored.memory.recover();
		expect(recovery.healthy).toBe(true);
		expect(recovery.reapplied).toBeGreaterThan(0);
		expect(restored.settings.diagnostics().keyError).toBeNull();
		expect(restored.settings.credential(connection)).toBe(
			"restore-fixture-credential",
		);
		const messages = restored.conversation.get("main").messages;
		expect(messages.some((message) => message.id === kept)).toBe(true);
		// Forget revokes memory/context sources; the original conversation log is retained by its existing contract.
		expect(restored.memory.blockedMessageIds([kept, forgotten])).toEqual(
			new Set([forgotten]),
		);
		expect(
			restored.store.read((db) =>
				restored!.memory.isSourceRevokedInTransaction(db, forgotten),
			),
		).toBe(true);
		expect(restored.dialogue.get(queued.id)).toMatchObject({
			status: "queued",
			conversationId: "restore-drill",
		});
		await close(restored);
		restored = undefined;
		for (const mode of ["missing-key", "wrong-key"]) {
			const folder = join(dir, mode);
			mkdirSync(folder);
			const path = join(folder, "db.sqlite3");
			copyFileSync(backupPath, path);
			if (mode === "wrong-key") {
				mkdirSync(join(folder, "keys"));
				writeFileSync(join(folder, "keys/settings.key"), randomBytes(32), {
					mode: 0o600,
				});
			}
			const store = openStore(path, migrations);
			try {
				const rejected = await createSettings(store, { dbPath: path, env: {} });
				expect(rejected.diagnostics().keyError).toBe("secret_key_unavailable");
				expect(rejected.credential(connection)).toBeNull();
			} finally {
				await store.close();
			}
		}
		const futurePath = join(dir, "future.sqlite3");
		copyFileSync(backupPath, futurePath);
		const future = openStore(futurePath, [
			...migrations,
			{
				id: "restore-fixture/0001-future",
				sql: "CREATE TABLE restore_future_fixture(id TEXT)",
				after: [migrations.at(-1)!.id],
			},
		]);
		await future.close();
		expect(() => openStore(futurePath, migrations)).toThrow(
			"migration_unknown_applied",
		);
	} finally {
		if (source) await close(source);
		if (restored) await close(restored);
		rmSync(dir, { recursive: true, force: true });
	}
}, 30_000);

test("schema 8 upgrades to 9 and rolls back with the latest forget journal", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-memory-cutover-"));
	const path = join(dir, "db.sqlite3");
	const journalPath = join(dir, "memory-forget-journal.jsonl");
	const oldArchive = new URL(
		"../../vendor/eumenes-memory/eumenes-memory-0.0.4-30721f30aa19.tgz",
		import.meta.url,
	);
	const scopeKey = "profile:owner";
	const access = {
		principal: "local:owner",
		scopeKeys: [scopeKey],
		purpose: "memory.cutover.fixture",
		policyRevision: "1",
	};
	const clock = { atMs: 1_800_000_000_000 };
	const migrationId = "memory-package/0009";
	let store: ReturnType<typeof openStore> | undefined;
	try {
		const unpack = Bun.spawnSync([
			"tar",
			"-xzf",
			oldArchive.pathname,
			"-C",
			dir,
		]);
		expect(unpack.exitCode).toBe(0);
		const previous = (await import(
			join(dir, "package/dist/sqlite.js")
		)) as typeof import("eumenes-memory/sqlite");
		expect(previous.MEMORY_DB_SCHEMA_VERSION).toBe(8);
		const previousMigrations = migrations
			.filter((migration) => migration.id !== migrationId)
			.map((migration) => {
				const prefix = "memory-package/";
				if (!migration.id.startsWith(prefix)) return migration;
				const index = Number(migration.id.slice(prefix.length)) - 1;
				return { ...migration, sql: previous.migrations[index]! };
			});
		store = openStore(path, previousMigrations);
		const texts = [
			"残す試験記憶の折り紙",
			"先に忘却する試験記憶",
			"切替後に忘却する試験記憶",
		];
		const [kept, earlyForget, lateForget] = await store.write((db) =>
			texts.map((text, index) => {
				const digest = createHash("sha256").update(text).digest("hex");
				const ref = {
					namespace: "cutover-fixture",
					kind: "message",
					id: String(index),
					representation: "text",
					revision: `sha256:${digest}`,
					digest,
				};
				const saved = previous.assertUserState(db, {
					contractVersion: 1,
					access,
					scopeKey,
					clock,
					subject: "self",
					kind: "preference",
					semanticKey: `cutover-${index}`,
					value: { text, polarity: "affirmed" },
					origin: "user_confirmed",
					evidence: [
						{
							source: {
								...ref,
								range: { startByte: 0, endByte: Buffer.byteLength(text) },
							},
							quote: text,
						},
					],
					sources: [
						{
							...ref,
							principal: access.principal,
							scopeKey,
							status: "available",
							content: text,
							ordinal: index + 1,
						},
					],
				});
				if (saved.status !== "applied") throw new Error("fixture seed failed");
				return saved.item.itemId;
			}),
		);
		const forget = (
			owner: ReturnType<typeof openStore>,
			itemId: string,
			lifecycle: {
				planForget: typeof planForget;
				applyForget: typeof applyForget;
			},
		) =>
			owner.write((db) => {
				const planned = lifecycle.planForget(db, {
					contractVersion: 2,
					access,
					clock,
					target: { type: "state_item", itemId, scopeKey },
				});
				if (planned.status !== "planned")
					throw new Error("fixture forget plan failed");
				appendJournal(journalPath, planned.plan.entry);
				return lifecycle.applyForget(db, {
					contractVersion: 2,
					entry: planned.plan.entry,
					clock,
				});
			});
		expect((await forget(store, earlyForget!, previous)).completed).toBe(true);
		await store.close();
		store = undefined;

		const { backupPath } = await backupDatabaseOnRequest(path);
		store = openStore(path, migrations);
		const search = (owner: ReturnType<typeof openStore>, term: string) =>
			owner.read((db) => {
				const result = searchState(db, {
					contractVersion: 1,
					access,
					scopeKeys: [scopeKey],
					terms: { indexed: [term], scanned: [] },
					limit: 20,
				});
				if (result.status !== "ok") throw new Error("fixture search failed");
				return result.items.map((item) => item.itemId);
			});
		expect(
			store.read((db) =>
				db
					.query(
						"SELECT value FROM memory_schema_info WHERE key='db_schema_version'",
					)
					.get(),
			),
		).toEqual({ value: "9" });
		expect(
			store.read((db) =>
				db
					.query("SELECT count(*) AS n FROM schema_migrations_v2 WHERE id=?")
					.get(migrationId),
			),
		).toEqual({ n: 1 });
		expect((await store.write(verifyStateSearchIndex)).consistent).toBe(true);
		expect(search(store, texts[0]!)).toEqual([kept]);
		expect(search(store, texts[1]!)).toEqual([]);
		expect(search(store, texts[2]!)).toEqual([lateForget]);
		expect(
			(await forget(store, lateForget!, { planForget, applyForget })).completed,
		).toBe(true);
		expect(search(store, texts[2]!)).toEqual([]);
		expect(store.read(readForgetJournalHead).seq).toBe(2);
		await store.close();
		store = undefined;

		expect(() => openStore(path, previousMigrations)).toThrow(
			"migration_unknown_applied:memory-package/0009",
		);
		const rollback = join(dir, "rollback.sqlite3");
		copyFileSync(backupPath, rollback);
		store = openStore(rollback, previousMigrations);
		const oldItems = (owner: ReturnType<typeof openStore>) =>
			owner.read((db) => {
				previous.assertMemorySchema(db);
				const result = previous.listState(db, {
					contractVersion: 1,
					access,
					scopeKey,
				});
				if (result.status !== "ok") throw new Error("fixture list failed");
				return result.items.map((item) => item.itemId);
			});
		expect(oldItems(store)).toEqual(expect.arrayContaining([kept, lateForget]));
		const entries = readJournal<ForgetJournalEntry>(journalPath);
		expect(entries).toHaveLength(2);
		const reconciled = await store.write((db) =>
			previous.reconcileForgetJournal(db, {
				contractVersion: 2,
				entries,
				clock,
			}),
		);
		expect(reconciled).toMatchObject({
			status: "ok",
			reapplied: 1,
			feedResyncRequired: true,
		});
		expect(oldItems(store)).toEqual([kept]);
		await store.close();
		store = openStore(rollback, previousMigrations);
		expect(oldItems(store)).toEqual([kept]);
	} finally {
		await store?.close();
		rmSync(dir, { recursive: true, force: true });
	}
}, 30_000);
