import { Database } from "bun:sqlite";
import { copyFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import { openStore } from "../../../infrastructure/sqlite";
import {
	CONVERSATION_DEFAULT_SCOPE,
	createConversationService,
} from "../../conversation";
import { createContinuityService } from "../../continuity";
import { createGoalsService } from "../../goals";
import { createMemoryService } from "../../memory";
import { createQueue } from "../../queue";
import { createStewardService } from "../service";
import {
	GOALS_ACCESS,
	createFakeInference,
	migrations,
	setupSteward,
	type StewardHarness,
} from "./steward.fixture";

let h: StewardHarness | undefined;
afterEach(async () => {
	await h?.close();
	h = undefined;
});

const rows = (store: StewardHarness["store"], sql: string) =>
	store.read((db) => db.query(sql).all()) as Array<Record<string, unknown>>;

// F11: the goal ids of a forget travel in the block journal line. A database restored from before the forget
// has the goal again; the journal line (which a restore does not touch) deletes it again at startup, before
// anything answers.
test("a database restored from before a goal forget loses the goal again at startup", async () => {
	h = await setupSteward({ goals: true });
	const message = await h.say("user", "音声応答の遅延を減らしたい");
	const goal = await h.goals!.adopt(GOALS_ACCESS, {
		scopeKey: CONVERSATION_DEFAULT_SCOPE,
		desiredState: "音声応答の遅延を減らしたい",
		source: { namespace: "conversation", kind: "message", id: message },
		sourceMessageIds: [message],
	});
	const keep = await h.say("user", "散歩したい");
	await h.goals!.adopt(GOALS_ACCESS, {
		scopeKey: CONVERSATION_DEFAULT_SCOPE,
		desiredState: "散歩を習慣にする",
		source: { namespace: "conversation", kind: "message", id: keep },
		sourceMessageIds: [keep],
	});
	// The backup a restore would bring back: both goals exist.
	const dbPath = join(h.dir, "db.sqlite3");
	const backup = join(h.dir, "backup.sqlite3");
	const reader = new Database(dbPath, { readonly: true });
	reader.exec(`VACUUM INTO '${backup}'`);
	reader.close();

	const resolved = h.store.read((db) =>
		h!.goals!.resolveForgetInTransaction(db, {
			goalIds: [goal.id],
			entityIds: [],
		}),
	);
	await h.memory.forget({
		conversationId: "c1",
		itemIds: [],
		messageIds: resolved.messageIds,
		derived: { goalIds: resolved.goalIds },
	});
	expect(
		rows(h.store, "SELECT desired_state AS text FROM goals_ledger"),
	).toEqual([{ text: "散歩を習慣にする" }]);

	// The process dies; the database file is replaced by the older backup; the block journal stays.
	const dir = h.dir;
	await h.store.close();
	for (const suffix of ["", "-wal", "-shm"])
		rmSync(`${dbPath}${suffix}`, { force: true });
	copyFileSync(backup, dbPath);

	const store = openStore(dbPath, migrations);
	try {
		expect(
			rows(store, "SELECT desired_state AS text FROM goals_ledger"),
		).toHaveLength(2);
		const conversation = createConversationService(store);
		const continuity = createContinuityService(store, () =>
			new Date().toISOString(),
		);
		const memory = createMemoryService(store, conversation, continuity, {
			journalPath: join(dir, "journal.jsonl"),
			clock: () => new Date().toISOString(),
			id: () => crypto.randomUUID(),
		});
		const queue = createQueue(store, {
			now: () => Date.now(),
			id: () => crypto.randomUUID(),
			sleep: () => new Promise(() => {}),
			random: () => 0,
			backoff: { baseMs: 1000, maxMs: 30_000 },
		});
		// As the application builds it: the steward registers its purge hook before memory recovers.
		createStewardService({
			store,
			memory,
			conversation,
			continuity,
			queue,
			inference: createFakeInference().port,
			foregroundActive: () => false,
			runStateOf: () => "stale",
			clock: () => new Date().toISOString(),
			nowMs: () => Date.now(),
			newId: () => crypto.randomUUID(),
			goals: { ops: createGoalsService(store), access: GOALS_ACCESS },
		});
		expect(store.read((db) => memory.readyInTransaction(db))).toBe(false);
		expect((await memory.recover()).healthy).toBe(true);
		expect(
			rows(store, "SELECT desired_state AS text FROM goals_ledger"),
		).toEqual([{ text: "散歩を習慣にする" }]);
		expect(rows(store, "SELECT message_id FROM goals_source")).toEqual([
			{ message_id: keep },
		]);
		expect(memory.blockedMessageIds([message, keep])).toEqual(
			new Set([message]),
		);
		// A normal restart repeats the purge without harm.
		expect((await memory.recover()).healthy).toBe(true);
		expect(rows(store, "SELECT COUNT(*) AS n FROM goals_ledger")).toEqual([
			{ n: 1 },
		]);
	} finally {
		await store.close().catch(() => {});
	}
});
