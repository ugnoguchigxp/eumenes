import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type SqliteStore } from "../../../infrastructure/sqlite";
import { createQueue, migrations as queueMigrations } from "../../queue";
import type { TaskCommand as Command } from "../contracts";
import * as repo from "../repository";
import { migrations } from "..";
import { createCommands } from "../service/commands";
import { createConfiguration } from "../service/configuration";
import { createInbox } from "../service/inbox";

/** The dots schema on a throw-away database; the task migration the production order names is not needed. */
export function memoryDb() {
	const db = new Database(":memory:");
	for (const m of migrations) db.exec(m.sql);
	return db;
}

export function fileStore() {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-dots-domain-"));
	const store = openStore(join(dir, "db.sqlite3"), [
		...queueMigrations,
		...migrations.map((m) => ({
			...m,
			after: m.id === "dots/0001-init" ? ["queue/0001-init"] : m.after,
		})),
	]);
	return {
		dir,
		store,
		queue: createQueue(store),
		async close() {
			await store.close().catch(() => {});
			rmSync(dir, { recursive: true, force: true });
		},
	};
}
export type FileStore = ReturnType<typeof fileStore>;

export const clock = (start = 1_000_000) => {
	const state = { now: start };
	return { state, now: () => state.now };
};

/** A store over one open database, so service methods that take a store run without a file. */
export const fakeStore = (db: Database) =>
	({
		read: (f: (db: Database) => unknown) => f(db),
		readSnapshot: (f: (db: Database) => unknown) => f(db),
		write: async (f: (db: Database) => unknown) => f(db),
	}) as unknown as SqliteStore;

export function connect(
	db: Database,
	id = "conn",
	options: { enabled?: boolean } = {},
) {
	return createConfiguration(
		undefined as unknown as SqliteStore,
	).configureInTransaction(db, {
		id,
		expectedRevision: 0,
		title: id,
		enabled: options.enabled ?? true,
		oauth: null,
	});
}

export function makeCommand(change: Partial<Command> = {}): Command {
	return {
		commandId: "cmd-1",
		taskId: "task-1",
		connectionRef: "conn",
		kind: "start",
		authorityEpoch: 1,
		executionGeneration: 1,
		createdAt: 1_000_000,
		expiresAt: 2_000_000,
		state: "pending",
		leaseId: null,
		snapshot: {
			protocolVersion: 1,
			task: { id: "task-1" },
			project: null,
			sessions: [],
		},
		...change,
	};
}

export function reportOf(
	command: Command,
	sourceSequence: number,
	kind: string,
	extra: Record<string, unknown> = {},
) {
	return {
		reportId: crypto.randomUUID(),
		commandId: command.commandId,
		taskId: command.taskId,
		authorityEpoch: command.authorityEpoch,
		executionGeneration: command.executionGeneration,
		sourceSequence,
		kind,
		summary: "報告",
		...extra,
	};
}

export function services(db: Database, now: () => number) {
	return {
		inbox: createInbox(now),
		commands: createCommands(fakeStore(db), now),
		config: createConfiguration(fakeStore(db)),
		repo,
	};
}
