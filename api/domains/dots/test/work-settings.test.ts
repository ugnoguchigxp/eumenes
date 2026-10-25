import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { createWorkSettings } from "../service/work-settings";
import { migrations } from "..";
import { defaultWorkSettings } from "../contracts/work-settings";
import { fileStore, memoryDb, connect, services } from "./support";
test("removing unused preparation settings preserves saved preferences and revision", () => {
	const db = new Database(":memory:");
	try {
		const cleanup = migrations.find(
			(m) => m.id === "dots/0006-remove-unused-work-settings",
		)!;
		for (const migration of migrations) {
			if (migration.id === cleanup.id) break;
			db.exec(migration.sql);
		}
		const settings = {
			...defaultWorkSettings,
			showInConversation: false,
			maxSessions: 2,
		};
		db.query("INSERT INTO dots_work_settings VALUES(1,7,?)").run(
			JSON.stringify({
				...settings,
				receiveOnStartup: true,
				requestPackageRevisionId: "package:dots.request@1",
			}),
		);
		db.exec(cleanup.sql);
		expect(createWorkSettings().inTransaction(db)).toEqual({
			revision: 7,
			settings,
		});
		expect(
			JSON.parse(
				(
					db.query("SELECT data_json FROM dots_work_settings").get() as {
						data_json: string;
					}
				).data_json,
			),
		).toEqual(settings);
	} finally {
		db.close();
	}
});
test("disabled settings survive closing and reopening SQLite, replay and conflict preserve their revision", async () => {
	const f = fileStore(),
		settings = createWorkSettings();
	try {
		const initial = f.store.readSnapshot(settings.inTransaction),
			data = {
				...initial.settings,
				showInConversation: false,
			};
		const input = {
			requestId: crypto.randomUUID(),
			expectedRevision: 0,
			settings: data,
			digest: "first",
		};
		await f.store.write((db) => settings.applyInTransaction(db, input));
		expect(
			(await f.store.write((db) => settings.applyInTransaction(db, input)))
				.replay,
		).toBe(true);
		await expect(
			f.store.write((db) =>
				settings.applyInTransaction(db, { ...input, digest: "changed" }),
			),
		).rejects.toThrow("dots_conflict");
		await f.store.close();
		const reopened = new Database(join(f.dir, "db.sqlite3"));
		expect(createWorkSettings().inTransaction(reopened)).toEqual({
			revision: 1,
			settings: data,
		});
		reopened.close();
	} finally {
		await f.close();
	}
});
test("connection/project mismatches and unavailable grants cannot be enabled", () => {
	const db = memoryDb(),
		s = createWorkSettings(),
		{ config } = services(db, Date.now);
	try {
		connect(db, "one");
		connect(db, "two");
		config.configureProjectInTransaction(db, {
			ref: "p",
			connectionRef: "two",
			expectedRevision: 0,
			title: "p",
			nativeProjectId: "p",
			hostId: "local",
			environment: "cloud",
			enabled: true,
		});
		expect(() =>
			s.applyInTransaction(db, {
				requestId: crypto.randomUUID(),
				expectedRevision: 0,
				digest: "bad",
				settings: {
					...s.inTransaction(db).settings,
					enabled: true,
					connectionRef: "one",
					projectRef: "p",
				},
			}),
		).toThrow("dots_settings_target_invalid");
		expect(s.inTransaction(db).revision).toBe(0);
	} finally {
		db.close();
	}
});
