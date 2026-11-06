import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContinuityService } from "../../domains/continuity";
import { createConversationService } from "../../domains/conversation";
import { createMemoryService } from "../../domains/memory";
import { openStore } from "../../infrastructure/sqlite";
import { migrations } from "../migrations";
import { createWorldAssembly, WORLD_DEFAULT_SCOPE } from "./world";

test("a pre-outbox message already forgotten in Memory is never received during initial sync", async () => {
	const dir = mkdtempSync(join(tmpdir(), "world-initial-forgotten-"));
	const store = openStore(join(dir, "db.sqlite3"), migrations);
	const conversation = createConversationService(store, {
		requireOutbox: true,
	});
	const memory = createMemoryService(
		store,
		conversation,
		createContinuityService(),
		{ journalPath: join(dir, "memory.jsonl") },
	);
	const world = createWorldAssembly({
		store,
		conversation,
		memory,
		mode: "on",
		journalPath: join(dir, "world.jsonl"),
		cursorSecret: "forgotten-initial-test-only-cursor-secret",
		intake: { blockedMessageIds: memory.blockedMessageIdsInTransaction },
	});
	try {
		await store.write((db) => {
			db.query(
				"INSERT INTO conversations (id, created_at) VALUES ('legacy', '2026-01-01')",
			).run();
			for (const id of ["keep", "gone"])
				db.query(
					"INSERT INTO messages (id, conversation_id, role, text, created_at) VALUES (?, 'legacy', 'user', '過去の発言', '2026-01-01')",
				).run(id);
		});
		await memory.recover();
		await memory.forget({
			conversationId: "legacy",
			itemIds: [],
			messageIds: ["gone"],
		});
		await world.recover();
		expect(world.status().world.enabled).toBe(true);
		const rows = store.read((db) =>
			db
				.query(
					"SELECT source_json,state,reason FROM world_host_extract_event ORDER BY source_json",
				)
				.all(),
		) as { source_json: string; state: string; reason: string | null }[];
		expect(
			rows.map((r) => ({
				id: JSON.parse(r.source_json).id,
				state: r.state,
				reason: r.reason,
			})),
		).toEqual([
			{ id: "gone", state: "skipped", reason: "SOURCE_BLOCKED" },
			{ id: "keep", state: "received", reason: null },
		]);
		expect(
			store.read((db) =>
				db.query("SELECT count(*) AS n FROM world_inbox").get(),
			),
		).toEqual({ n: 1 });
	} finally {
		await world.close();
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("initial sync receives pre-outbox messages before enabling; restart and resend do not duplicate them", async () => {
	const dir = mkdtempSync(join(tmpdir(), "world-initial-sync-"));
	const store = openStore(join(dir, "db.sqlite3"), migrations);
	const conversation = createConversationService(store, {
		requireOutbox: true,
	});
	const memory = createMemoryService(
		store,
		conversation,
		createContinuityService(),
		{
			journalPath: join(dir, "memory.jsonl"),
		},
	);
	const staged: { enabled: boolean; complete: boolean }[] = [];
	const options = {
		store,
		conversation,
		memory,
		mode: "on" as const,
		intake: {
			blockedMessageIds: memory.blockedMessageIdsInTransaction,
			onEventsReceived: () =>
				staged.push({
					enabled: world.status().world.enabled,
					complete: world.status().initialSyncComplete,
				}),
		},
		journalPath: join(dir, "world.jsonl"),
		cursorSecret: "initial-sync-test-only-cursor-secret",
	};
	let world = createWorldAssembly(options);
	try {
		await store.write((db) => {
			db.query(
				"INSERT INTO conversations (id, created_at) VALUES ('legacy', '2026-01-01')",
			).run();
			db.query(
				"INSERT INTO messages (id, conversation_id, role, text, created_at) VALUES ('old', 'legacy', 'user', '以前の発言', '2026-01-01')",
			).run();
		});
		await memory.recover();
		expect((await world.recover()).status).toBe("open");
		const events = () =>
			store.read((db) =>
				db
					.query(
						"SELECT event_id, state FROM world_host_extract_event ORDER BY event_id",
					)
					.all(),
			);
		expect(staged).toEqual([{ enabled: false, complete: false }]);
		expect(events()).toHaveLength(1);
		expect(events()[0]).toMatchObject({ state: "received" });
		expect(world.status()).toMatchObject({
			initialSyncComplete: true,
			world: { enabled: true },
		});
		const before = events();
		await world.close();
		world = createWorldAssembly(options);
		await world.recover();
		await world.lifecycle.startRestore();
		await world.pump();
		expect(events()).toEqual(before);
		expect(
			store.read((db) => conversation.changesInTransaction(db, 0, 100)),
		).toHaveLength(1);
		await conversation.retract({ messageId: "old" });
		await world.pump();
		expect(events()).toHaveLength(0);
		expect(
			store.read((db) =>
				db.query("SELECT count(*) AS n FROM world_inbox").get(),
			),
		).toEqual({
			n: 0,
		});
		await world.lifecycle.startRestore();
		await world.pump();
		expect(events()).toHaveLength(0);
	} finally {
		await world.close();
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("upgrade revokes the old outbox-only completion; interrupted initial sync resumes without duplicating receipts", async () => {
	const dir = mkdtempSync(join(tmpdir(), "world-initial-upgrade-"));
	const path = join(dir, "db.sqlite3");
	let store = openStore(
		path,
		migrations.filter((m) => m.id !== "world/0012-initial-source-sync"),
	);
	try {
		await store.write((db) => {
			db.query(
				"INSERT INTO conversations (id, created_at) VALUES ('legacy', '2026-01-01')",
			).run();
			for (let i = 0; i < 505; i++)
				db.query(
					"INSERT INTO messages (id, conversation_id, role, text, created_at) VALUES (?, 'legacy', 'user', '過去の発言', '2026-01-01')",
				).run(`old-${i}`);
			db.query(
				"UPDATE world_host_state SET initial_sync_complete=1, enabled=1 WHERE id=1",
			).run();
		});
		await store.close();
		store = openStore(path, migrations);
		expect(
			store.read((db) =>
				db
					.query("SELECT enabled,initial_sync_complete FROM world_host_state")
					.get(),
			),
		).toEqual({ enabled: 0, initial_sync_complete: 0 });
		const conversation = createConversationService(store, {
			requireOutbox: true,
		});
		const memory = createMemoryService(
			store,
			conversation,
			createContinuityService(),
			{
				journalPath: join(dir, "memory.jsonl"),
			},
		);
		await memory.recover();
		const options = {
			store,
			conversation,
			memory,
			mode: "on" as const,
			journalPath: join(dir, "world.jsonl"),
			cursorSecret: "initial-upgrade-test-only-cursor-secret",
		};
		let pages = 0;
		let world = createWorldAssembly({
			...options,
			lifecycle: {
				hook(point) {
					if (point === "feed_cursor_saved" && ++pages === 2) {
						throw new Error("interrupted sync");
					}
				},
			},
		});
		try {
			await world.recover();
			expect(world.status()).toMatchObject({
				initialSyncComplete: false,
				world: { enabled: false },
			});
			const cursor = () =>
				store.read((db) =>
					world.service.feedCursor(db, "source", WORLD_DEFAULT_SCOPE),
				);
			const committed = cursor();
			expect(
				store.read((db) =>
					db.query("SELECT count(*) AS n FROM world_host_extract_event").get(),
				),
			).toEqual({ n: 500 });
			expect(committed.cursor).not.toBeNull();
			await world.lifecycle.prepareInitialSourceSync(WORLD_DEFAULT_SCOPE);
			expect(cursor()).toEqual(committed);
			await world.close();
			// A correction and a retraction while stopped must win over the original backfill.
			await conversation.correct({ messageId: "old-504", text: "訂正後" });
			await conversation.retract({ messageId: "old-1" });
			world = createWorldAssembly(options);
			await world.recover();
			expect(world.status()).toMatchObject({
				initialSyncComplete: true,
				world: { enabled: true },
			});
			const rows = () =>
				store.read((db) =>
					db
						.query(
							"SELECT event_id,state,source_json FROM world_host_extract_event ORDER BY event_id",
						)
						.all(),
				);
			expect(rows()).toHaveLength(504);
			expect(
				rows().every((r) => (r as { state: string }).state === "received"),
			).toBe(true);
			expect(
				rows().some(
					(r) =>
						JSON.parse((r as { source_json: string }).source_json).id ===
						"old-1",
				),
			).toBe(false);
			const current = store.read((db) =>
				conversation.sourceInTransaction(db, "old-504"),
			);
			if (current.state !== "available")
				throw new Error("corrected source missing");
			const corrected = rows()
				.map((r) => JSON.parse((r as { source_json: string }).source_json))
				.filter((r) => r.id === "old-504");
			expect(corrected).toHaveLength(1);
			expect(corrected[0].revision).toBe(current.revision);
			const before = rows();
			await world.setEnabled(false);
			await world.setEnabled(true);
			await world.pump();
			expect(rows()).toEqual(before);
		} finally {
			await world.close();
		}
	} finally {
		await store.close().catch(() => {});
		rmSync(dir, { recursive: true, force: true });
	}
});
