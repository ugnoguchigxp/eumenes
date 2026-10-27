import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrations } from "..";
import { readCut, writeCut } from "../repository/input";
import { openStore } from "../../../infrastructure/sqlite";

// Deployed 0011 SQL: independent of the current definition so editing it cannot hide an upgrade failure.
const deployedInputSql = `
CREATE TABLE conversation_utterances (
 conversation_id TEXT NOT NULL, seq INTEGER NOT NULL,
 speaker TEXT NOT NULL CHECK(speaker IN ('user','agent')),
 text TEXT NOT NULL, message_id TEXT, created_at TEXT NOT NULL, retracted_at TEXT,
 PRIMARY KEY (conversation_id, seq)
);
CREATE UNIQUE INDEX conversation_utterances_message ON conversation_utterances(conversation_id, speaker, message_id) WHERE message_id IS NOT NULL;
CREATE INDEX conversation_utterances_message_id ON conversation_utterances(message_id);
CREATE TABLE conversation_cuts (
 conversation_id TEXT PRIMARY KEY, cut_seq INTEGER NOT NULL, revision INTEGER NOT NULL,
 system_digest TEXT NOT NULL, memory_version INTEGER, due TEXT, cut_at TEXT NOT NULL
);
CREATE TABLE conversation_states (
 conversation_id TEXT NOT NULL, version INTEGER NOT NULL,
 state_json TEXT NOT NULL, based_on_seq INTEGER NOT NULL, created_at TEXT NOT NULL,
 PRIMARY KEY (conversation_id, version)
);
`;

test("the deployed input migration keeps its recorded checksum", () => {
	const deployedChecksum =
		"65f90c40c45e7644f0e21fd2b1d79199661e40c5d6f92b9721af4856ff6ee657";
	const hash = (sql: string) => createHash("sha256").update(sql).digest("hex");
	expect(hash(deployedInputSql)).toBe(deployedChecksum);
	expect(
		hash(migrations.find((m) => m.id === "conversation/0011-input")!.sql),
	).toBe(deployedChecksum);
});

test("a deployed input database upgrades without losing cuts, utterances, state or migration history", async () => {
	const dir = mkdtempSync(join(tmpdir(), "conversation-input-upgrade-"));
	const path = join(dir, "db.sqlite3");
	const oldMigrations = migrations
		.filter((m) => m.id !== "conversation/0012-input-memory-digest")
		.map((m) =>
			m.id === "conversation/0011-input" ? { ...m, sql: deployedInputSql } : m,
		);
	let store = openStore(path, oldMigrations);
	try {
		await store.write((db) => {
			for (const [id, version] of [
				["c1", null],
				["c2", 0],
				["c3", 7],
			] as const)
				db.query(
					"INSERT INTO conversation_cuts VALUES (?, 12, 3, 'system', ?, 'forget', 'before')",
				).run(id, version);
			db.exec(
				"INSERT INTO conversation_utterances VALUES ('c1', 12, 'agent', 'retained', 'm1', 'before', NULL)",
			);
			db.exec(
				"INSERT INTO conversation_states VALUES ('c1', 2, '{}', 12, 'before')",
			);
		});
		const snapshot = () =>
			store.read((db) => ({
				cuts: db
					.query(
						"SELECT conversation_id,cut_seq,revision,system_digest,memory_version,due,cut_at FROM conversation_cuts ORDER BY conversation_id",
					)
					.all(),
				utterances: db.query("SELECT * FROM conversation_utterances").all(),
				states: db.query("SELECT * FROM conversation_states").all(),
				history: db
					.query(
						"SELECT * FROM schema_migrations_v2 WHERE id != 'conversation/0012-input-memory-digest' ORDER BY id",
					)
					.all(),
			}));
		const before = snapshot();
		await store.close();
		store = openStore(path, migrations);
		expect(snapshot()).toEqual(before);
		for (const id of ["c1", "c2", "c3"])
			expect(store.read((db) => readCut(db, id))).toMatchObject({
				seq: 12,
				revision: 3,
				memoryDigest: "",
				due: "forget",
			});
		await store.write((db) =>
			writeCut(db, "c1", {
				seq: 13,
				systemDigest: "system",
				memoryDigest: "new-digest",
				at: "after",
			}),
		);
		const applied = store.read((db) =>
			db.query("SELECT * FROM schema_migrations_v2 ORDER BY id").all(),
		);
		await store.close();
		store = openStore(path, migrations);
		expect(store.read((db) => readCut(db, "c1"))).toMatchObject({
			seq: 13,
			revision: 3,
			memoryDigest: "new-digest",
			due: null,
		});
		expect(
			store.read((db) =>
				db.query("SELECT * FROM schema_migrations_v2 ORDER BY id").all(),
			),
		).toEqual(applied);
	} finally {
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a fresh database stores and reads the cut's memory digest", async () => {
	const dir = mkdtempSync(join(tmpdir(), "conversation-input-fresh-"));
	const store = openStore(join(dir, "db.sqlite3"), migrations);
	try {
		await store.write((db) =>
			writeCut(db, "c1", {
				seq: 5,
				systemDigest: "system",
				memoryDigest: "digest",
				at: "now",
			}),
		);
		expect(store.read((db) => readCut(db, "c1"))).toEqual({
			seq: 5,
			revision: 1,
			systemDigest: "system",
			memoryDigest: "digest",
			due: null,
			at: "now",
		});
	} finally {
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
