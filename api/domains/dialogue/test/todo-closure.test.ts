import type { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import { closeRetiredTodosInTransaction } from "../service/todo-closure";
import { openDialogueStore, removeDialogueStore } from "./store.fixture";

const NOW = "2026-11-25T00:00:00.000Z";
const REVISION = "toolchain:fake.task@1";

let opened: { dir: string; store: SqliteStore } | undefined;
afterEach(async () => {
	if (!opened) return;
	await opened.store.close();
	removeDialogueStore(opened.dir);
	opened = undefined;
});

function open() {
	opened = openDialogueStore("todo-closure-");
	return opened.store;
}

function seedConversation(db: Database) {
	db.run("INSERT INTO conversations(id, created_at) VALUES ('main', ?)", [NOW]);
	db.run(
		"INSERT INTO messages(id, conversation_id, role, text, created_at) VALUES ('m1','main','user','x',?)",
		[NOW],
	);
	db.run(
		"INSERT INTO dialogue_runs(id, request_id, conversation_id, status, revision, input_message_id, created_at, updated_at, seq) VALUES ('r1','req1','main','completed',1,'m1',?,?,1)",
		[NOW, NOW],
	);
}

function todo(
	db: Database,
	id: string,
	execution: string,
	sourceRef: string | null,
	extra: { status?: string; archivedAt?: string | null } = {},
) {
	db.run(
		`INSERT INTO dialogue_work(id, conversation_id, run_id, toolchain_id, toolchain_revision_id, execution, request, title,
		 status, revision, source_ref, dedupe_key, archived_at, created_at, updated_at)
		 VALUES (?, 'main', 'r1', 'fake.task', ?, ?, 'request', 'title', ?, 1, ?, ?, ?, ?, ?)`,
		[
			id,
			REVISION,
			execution,
			extra.status ?? "todo",
			sourceRef,
			`key-${id}`,
			extra.archivedAt ?? null,
			NOW,
			NOW,
		],
	);
}

function confirmation(db: Database, id: string, usedAt: string | null) {
	db.run(
		`INSERT INTO dialogue_confirmations(id, conversation_id, toolchain_id, toolchain_revision_id, request, impact,
		 statement_delivery_key, issued_at, expires_at, used_at) VALUES (?, 'main', 'fake.task', ?, 'request', 'low', ?, ?, ?, ?)`,
		[id, REVISION, `key-${id}`, NOW, NOW, usedAt],
	);
}

function interaction(db: Database, id: string, status: string) {
	db.run(
		`INSERT INTO command_interactions(id, conversation_id, origin_message_id, origin_run_id, current_run_id,
		 chain_revision_id, function_name, package_revision_id, binding_revision_id, revision, authority_epoch,
		 execution_generation, status, question_id, question_count, request_id, expires_at, created_at, updated_at)
		 VALUES (?, 'main', 'm1', 'r1', 'r1', 'chain', 'fake', 'package', 'binding', 1, 1, 1, ?, ?, 0, ?, ?, ?, ?)`,
		[
			id,
			status,
			status === "waiting_input" ? `q-${id}` : null,
			`req-${id}`,
			NOW,
			NOW,
			NOW,
		],
	);
}

function deps(
	cancels: string[],
	options: { failOn?: string; noOwner?: boolean } = {},
) {
	const cancel = (db: Database, conversationId: string, id: string) => {
		// A side effect that must roll back when the owner then fails.
		db.run("UPDATE conversations SET revision = revision + 1 WHERE id = ?", [
			conversationId,
		]);
		if (id === options.failOn) throw new Error("owner_failed");
		cancels.push(id);
	};
	return {
		clock: () => NOW,
		toolchains: {
			taskInTransaction: (_db: Database, revisionId: string) =>
				options.noOwner || revisionId !== REVISION
					? undefined
					: { cancelInTransaction: cancel },
		},
		agents: {
			executions: {
				cancelByUserInTransaction: (
					db: Database,
					conversationId: string,
					id: string,
				) => cancel(db, conversationId, `agents:${id}`),
			},
		},
	} as unknown as Parameters<typeof closeRetiredTodosInTransaction>[0];
}

test("an open task TODO is cancelled at its owner and closed as interrupted; a second call closes none", async () => {
	const store = open();
	await store.write((db) => {
		seedConversation(db);
		todo(db, "w1", "task", "exec-1");
		todo(db, "w2", "pipeline", "exec-2", { status: "waiting" });
		todo(db, "w3", "command", null);
		todo(db, "w4", "task", "exec-4", { status: "done", archivedAt: NOW });
	});
	const cancels: string[] = [];
	const first = await store.write((db) =>
		closeRetiredTodosInTransaction(deps(cancels), db),
	);
	expect(first).toEqual({ closed: 3, cancelled: 2 });
	expect(cancels.sort()).toEqual(["exec-1", "exec-2"]);
	const rows = store.read((db) =>
		db
			.query(
				"SELECT id, status, outcome, archived_at, notice_read_at, revision FROM dialogue_work ORDER BY id",
			)
			.all(),
	);
	expect(rows).toEqual([
		{
			id: "w1",
			status: "done",
			outcome: "interrupted",
			archived_at: NOW,
			notice_read_at: NOW,
			revision: 2,
		},
		{
			id: "w2",
			status: "done",
			outcome: "interrupted",
			archived_at: NOW,
			notice_read_at: NOW,
			revision: 2,
		},
		{
			id: "w3",
			status: "done",
			outcome: "interrupted",
			archived_at: NOW,
			notice_read_at: NOW,
			revision: 2,
		},
		{
			id: "w4",
			status: "done",
			outcome: null,
			archived_at: NOW,
			notice_read_at: null,
			revision: 1,
		},
	]);
	const second = await store.write((db) =>
		closeRetiredTodosInTransaction(deps(cancels), db),
	);
	expect(second).toEqual({ closed: 0, cancelled: 0 });
	expect(cancels).toHaveLength(2);
});

test("without a registered owner the agent runtime cancels the task", async () => {
	const store = open();
	await store.write((db) => {
		seedConversation(db);
		todo(db, "w1", "task", "exec-1");
	});
	const cancels: string[] = [];
	await store.write((db) =>
		closeRetiredTodosInTransaction(deps(cancels, { noOwner: true }), db),
	);
	expect(cancels).toEqual(["agents:exec-1"]);
});

test("open confirmations and command interactions are closed; used and ended ones are left", async () => {
	const store = open();
	await store.write((db) => {
		seedConversation(db);
		confirmation(db, "c1", null);
		confirmation(db, "c2", NOW);
		interaction(db, "i1", "waiting_input");
		interaction(db, "i2", "ready");
		interaction(db, "i3", "completed");
	});
	await store.write((db) => closeRetiredTodosInTransaction(deps([]), db));
	expect(
		store.read((db) =>
			db
				.query(
					"SELECT id, used_at, superseded_at FROM dialogue_confirmations ORDER BY id",
				)
				.all(),
		),
	).toEqual([
		{ id: "c1", used_at: null, superseded_at: NOW },
		{ id: "c2", used_at: NOW, superseded_at: null },
	]);
	expect(
		store.read((db) =>
			db
				.query(
					"SELECT id, status, end_code, ended_at, question_id, revision FROM command_interactions ORDER BY id",
				)
				.all(),
		),
	).toEqual([
		{
			id: "i1",
			status: "cancelled",
			end_code: "ledger_retired",
			ended_at: NOW,
			question_id: null,
			revision: 2,
		},
		{
			id: "i2",
			status: "cancelled",
			end_code: "ledger_retired",
			ended_at: NOW,
			question_id: null,
			revision: 2,
		},
		{
			id: "i3",
			status: "completed",
			end_code: null,
			ended_at: null,
			question_id: null,
			revision: 1,
		},
	]);
	expect(
		store.read((db) =>
			db
				.query(
					"SELECT interaction_id, kind FROM command_interaction_events ORDER BY interaction_id",
				)
				.all(),
		),
	).toEqual([
		{ interaction_id: "i1", kind: "end" },
		{ interaction_id: "i2", kind: "end" },
	]);
});

test("an owner that throws still lets the other rows close, and its own writes roll back", async () => {
	const store = open();
	await store.write((db) => {
		seedConversation(db);
		todo(db, "w1", "task", "exec-1");
		todo(db, "w2", "task", "exec-2");
		confirmation(db, "c1", null);
		interaction(db, "i1", "waiting_input");
	});
	const cancels: string[] = [];
	const result = await store.write((db) =>
		closeRetiredTodosInTransaction(deps(cancels, { failOn: "exec-1" }), db),
	);
	expect(result).toEqual({ closed: 2, cancelled: 1 });
	expect(cancels).toEqual(["exec-2"]);
	expect(
		store.read((db) =>
			db.query("SELECT outcome FROM dialogue_work ORDER BY id").all(),
		),
	).toEqual([{ outcome: "interrupted" }, { outcome: "interrupted" }]);
	// Only the surviving cancel's side effect remains.
	expect(
		store.read((db) =>
			db.query("SELECT revision FROM conversations WHERE id='main'").get(),
		),
	).toEqual({ revision: 1 });
	expect(
		store.read((db) =>
			db.query("SELECT superseded_at FROM dialogue_confirmations").get(),
		),
	).toEqual({ superseded_at: NOW });
	expect(
		store.read((db) =>
			db.query("SELECT status FROM command_interactions").get(),
		),
	).toEqual({ status: "cancelled" });
});
