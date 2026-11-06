import { expect, test } from "bun:test";
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
