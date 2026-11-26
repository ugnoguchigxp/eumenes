import type { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openStore, type SqliteStore } from "../../../infrastructure/sqlite";
import { forgetRetiredTodoTracesInTransaction } from "../service/retired-todo-traces";
import { dialogueMigrationList } from "./store.fixture";

const NOW = "2026-11-25T00:00:00.000Z";
const DROP = "dialogue/0049-drop-retired-todos";

let dir: string | undefined;
let open: SqliteStore | undefined;
afterEach(async () => {
	await open?.close();
	if (dir) rmSync(dir, { recursive: true, force: true });
	open = dir = undefined;
});

function todo(
	db: Database,
	id: string,
	toolchainId: string,
	sourceRef: string,
) {
	db.run(
		`INSERT INTO dialogue_work(id, conversation_id, run_id, toolchain_id, toolchain_revision_id, execution, request, title,
		 status, revision, source_ref, dedupe_key, created_at, updated_at, message_ids_json)
		 VALUES (?, 'main', 'r1', ?, ?, 'task', 'old request', 'title', 'done', 1, ?, ?, ?, ?, '["m1"]')`,
		[
			id,
			toolchainId,
			`toolchain:${toolchainId}@1`,
			sourceRef,
			`key-${id}`,
			NOW,
			NOW,
		],
	);
}

function resource(db: Database, ref: number, workId: string) {
	db.run(
		`INSERT INTO dialogue_resources(id, conversation_id, ref, uri, kind, label, source, work_id, used_at, created_at)
		 VALUES (?, 'main', ?, ?, 'image', 'label', 'work', ?, ?, ?)`,
		[`res-${ref}`, ref, `eumenes://image/${ref}`, workId, NOW, NOW],
	);
}

/** A database the TODO ledger wrote to, then upgraded: the drop migration runs on its rows. */
async function upgraded() {
	dir = mkdtempSync(join(tmpdir(), "retired-todos-"));
	const path = join(dir, "db.sqlite3");
	const before = openStore(
		path,
		dialogueMigrationList().filter((m) => m.id !== DROP),
	);
	try {
		await before.write((db) => {
			db.run("INSERT INTO conversations(id, created_at) VALUES ('main', ?)", [
				NOW,
			]);
			db.run(
				"INSERT INTO messages(id, conversation_id, role, text, created_at) VALUES ('m1','main','user','x',?)",
				[NOW],
			);
			db.run(
				"INSERT INTO dialogue_runs(id, request_id, conversation_id, status, revision, input_message_id, created_at, updated_at, seq) VALUES ('r1','req1','main','completed',1,'m1',?,?,1)",
				[NOW, NOW],
			);
			todo(db, "w1", "web.research", "pursuit-1");
			todo(db, "w2", "image.create", "exec-2");
			todo(db, "w3", "web.research", "");
			db.run(
				`INSERT INTO dialogue_confirmations(id, conversation_id, toolchain_id, toolchain_revision_id, request, impact,
				 statement_delivery_key, issued_at, expires_at) VALUES ('c1', 'main', 'image.create', 'toolchain:image.create@1', 'old request', 'low', 'k', ?, ?)`,
				[NOW, NOW],
			);
			resource(db, 1, "w2");
			resource(db, 2, "root-of-an-assignment");
		});
	} finally {
		await before.close();
	}
	open = openStore(path, dialogueMigrationList());
	return open;
}

test("the drop migration removes the TODO ledger's tables, hides what a TODO made and keeps what is left to forget", async () => {
	const store = await upgraded();
	store.read((db) => {
		const tables = (
			db
				.query("SELECT name FROM sqlite_master WHERE type='table'")
				.all() as Array<{ name: string }>
		).map((t) => t.name);
		for (const gone of [
			"dialogue_work",
			"dialogue_confirmations",
			"command_interactions",
			"command_interaction_events",
			"dialogue_generated_images",
		])
			expect(tables).not.toContain(gone);
		expect(
			db
				.query(
					"SELECT kind, id FROM dialogue_retired_todo_traces ORDER BY kind, id",
				)
				.all(),
		).toEqual([
			{ kind: "event", id: "work:w1" },
			{ kind: "event", id: "work:w2" },
			{ kind: "event", id: "work:w3" },
			{ kind: "research", id: "pursuit-1" },
		]);
		const shown = db
			.query("SELECT id FROM dialogue_resources WHERE forgotten_at IS NULL")
			.all();
		// Only the resource a TODO made is hidden; an assignment's stays.
		expect(shown).toEqual([{ id: "res-2" }]);
	});
});

test("the startup forgets the events at continuity and the research at its owner, once; research waits for its owner", async () => {
	const store = await upgraded();
	const events: string[][] = [];
	const research: string[][] = [];
	const deps = {
		clock: () => NOW,
		continuity: {
			events: {
				forgetMessagesInTransaction: (
					_db: Database,
					ids: readonly string[],
				) => {
					events.push([...ids]);
					return [];
				},
			},
		},
	} as unknown as Parameters<typeof forgetRetiredTodoTracesInTransaction>[0];
	const erase = (_db: Database, ids: readonly string[]) => {
		research.push([...ids]);
	};
	// No owner registered yet: the events are forgotten, the research waits.
	expect(
		await store.write((db) =>
			forgetRetiredTodoTracesInTransaction(deps, db, undefined),
		),
	).toBe(3);
	expect(events).toEqual([["work:w1", "work:w2", "work:w3"]]);
	expect(research).toEqual([]);
	expect(
		await store.write((db) =>
			forgetRetiredTodoTracesInTransaction(deps, db, erase),
		),
	).toBe(1);
	expect(research).toEqual([["pursuit-1"]]);
	expect(
		await store.write((db) =>
			forgetRetiredTodoTracesInTransaction(deps, db, erase),
		),
	).toBe(0);
	expect(events).toHaveLength(1);
	expect(research).toHaveLength(1);
});
