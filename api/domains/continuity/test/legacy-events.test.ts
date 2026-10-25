import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { eventsMigration } from "../repository/events";
import { archiveLegacyContinuityEventsInTransaction as archive } from "../repository/legacy-events";
import { legacyEventsSchema } from "./legacy-events.fixture";

test("the retired ledger blocks the event migration; archiving preserves its rows and indexes", () => {
	const db = new Database(":memory:");
	try {
		db.exec(legacyEventsSchema);
		db.exec(`INSERT INTO continuity_events VALUES
		 (1,'event','bookmark','conversation','create','goal','fixture text','active',1,
		 'message','digest','user_confirmed','request','request-digest','2026-10-01')`);
		const before = db.query("SELECT * FROM continuity_events").all();
		expect(() => db.transaction(() => db.exec(eventsMigration))()).toThrow(
			"already exists",
		);
		expect(db.transaction(() => archive(db))()).toBe(true);
		expect(
			db.query("SELECT * FROM continuity_legacy_bookmark_events").all(),
		).toEqual(before);
		expect(
			db
				.query(
					"SELECT name FROM sqlite_schema WHERE type='index' AND tbl_name='continuity_legacy_bookmark_events'",
				)
				.all(),
		).toHaveLength(5);
		db.exec(eventsMigration);
		db.exec(`INSERT INTO continuity_events
		 (conversation_id,seq,at,type,actor,status,full_text,full_tokens)
		 VALUES ('conversation',1,'now','said','user','pending','new event',1)`);
		expect(archive(db)).toBe(false);
		expect(db.query("SELECT full_text FROM continuity_events").get()).toEqual({
			full_text: "new event",
		});
		expect(
			db.query("SELECT * FROM continuity_legacy_bookmark_events").all(),
		).toEqual(before);
	} finally {
		db.close();
	}
});

test("absent tables are a no-op; unknown shapes and occupied archive names are refused", () => {
	const db = new Database(":memory:");
	try {
		expect(archive(db)).toBe(false);
		db.exec("CREATE TABLE continuity_events (unknown TEXT)");
		expect(() => archive(db)).toThrow("continuity_legacy_schema_unknown");
		db.exec("DROP TABLE continuity_events");
		db.exec(legacyEventsSchema);
		db.exec("CREATE TABLE continuity_legacy_bookmark_events (untouched TEXT)");
		expect(() => archive(db)).toThrow("continuity_legacy_archive_exists");
		expect(
			db.query("SELECT COUNT(*) AS n FROM continuity_events").get(),
		).toEqual({ n: 0 });
	} finally {
		db.close();
	}
});
