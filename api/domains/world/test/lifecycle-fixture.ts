import { Database } from "bun:sqlite";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONTRACT_VERSIONS } from "eumenes-memory";
import {
	applyForget,
	getForgetReceipt,
	planForget,
} from "eumenes-memory/sqlite";
import type { ForgetJournalEntry } from "eumenes-memory/sqlite";
import { migrations } from "../../../application/migrations";
import { openStore, type SqliteStore } from "../../../infrastructure/sqlite";
import { createConversationService } from "../../conversation";
import {
	createConversationSourceAdapter,
	createWorldHostGate,
	createWorldLifecycle,
	createWorldService,
	type LifecycleOptions,
	type LifecyclePoint,
	type WorldHostGate,
	type WorldLifecycle,
	type WorldService,
} from "..";
import {
	ACCESS,
	NOW,
	PURPOSE,
	SCOPE,
	memoryPolicyRevision,
	type Harness,
} from "./fixture";

/** A process crash, simulated by throwing from a lifecycle hook. */
export class Crash extends Error {
	constructor(readonly point: LifecyclePoint) {
		super(`simulated_crash_${point}`);
	}
}

/** Throws a Crash the nth time the point is reached. */
export function crashHook(
	point: LifecyclePoint,
	nth = 1,
): NonNullable<LifecycleOptions["hook"]> {
	let hits = 0;
	return (reached) => {
		if (reached !== point) return;
		hits += 1;
		if (hits === nth) throw new Crash(point);
	};
}

export type Life = Harness & {
	gate: WorldHostGate;
	lifecycle: WorldLifecycle;
	journalPath: string;
	dir: string;
	/** Opened with an `over` so a test can swap hooks and Memory ports. */
	over: Partial<LifecycleOptions>;
};

function build(
	dir: string,
	path: string,
	over: Partial<LifecycleOptions>,
): Life {
	const store: SqliteStore = openStore(path, migrations);
	const gate = createWorldHostGate("closed");
	const conversation = createConversationService(store, {
		requireOutbox: true,
	});
	const sourceAdapter = createConversationSourceAdapter(conversation, {
		allowedPurposes: [PURPOSE],
	});
	const world: WorldService = createWorldService({
		store,
		policyRevision: memoryPolicyRevision,
		sources: [sourceAdapter],
		gate,
	});
	const journalPath = join(dir, "world-journal.jsonl");
	const lifecycle = createWorldLifecycle({
		store,
		world,
		journalPath,
		gate,
		purpose: PURPOSE,
		sources: [sourceAdapter],
		scopes: [SCOPE],
		clock: () => NOW,
		...over,
	});
	return {
		store,
		conversation,
		world,
		path,
		gate,
		lifecycle,
		journalPath,
		dir,
		over,
		async cleanup() {
			await store.close().catch(() => {});
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

/** A temp-file store with the real production migrations, World ON, gate CLOSED until recoverWorld(). */
export async function openLife(
	over: Partial<LifecycleOptions> = {},
): Promise<Life> {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-world-life-"));
	const life = build(dir, join(dir, "db.sqlite3"), over);
	try {
		await life.store.write((db) => {
			db.exec(
				"CREATE TABLE host_probe (n INTEGER NOT NULL); CREATE TABLE host_queue (cursor TEXT NOT NULL);",
			);
		});
		await life.world.setEnabled(true);
		return life;
	} catch (error) {
		await life.cleanup();
		throw error;
	}
}

/** The same database and journal in a new "process": new store, service, lifecycle, gate. */
export async function reopenLife(
	previous: Life,
	over: Partial<LifecycleOptions> = {},
): Promise<Life> {
	await previous.store.close().catch(() => {});
	return build(previous.dir, previous.path, over);
}

/** A consistent copy of the database (what a backup would hold). */
export function backupDatabase(life: Life, name = "backup.sqlite3"): string {
	const target = join(life.dir, name);
	const reader = new Database(life.path, { readonly: true });
	try {
		reader.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`);
	} finally {
		reader.close();
	}
	return target;
}

/** Replaces the database file by a backup and reopens (the journal file stays). */
export async function restoreDatabase(
	previous: Life,
	backup: string,
	over: Partial<LifecycleOptions> = {},
): Promise<Life> {
	await previous.store.close().catch(() => {});
	for (const suffix of ["", "-wal", "-shm"])
		rmSync(`${previous.path}${suffix}`, { force: true });
	copyFileSync(backup, previous.path);
	return build(previous.dir, previous.path, over);
}

/** Memory forgets a source; returns Memory's forgetId and journal entry. */
export async function memoryForgetSource(
	life: Life,
	sourceKey: string,
): Promise<{ forgetId: string; entry: ForgetJournalEntry }> {
	return life.store.write((db) => {
		const planned = planForget(db, {
			contractVersion: CONTRACT_VERSIONS.lifecycle,
			access: { ...ACCESS, policyRevision: memoryPolicyRevision(db) },
			target: {
				type: "host_source",
				sourceKey,
				scopeKey: SCOPE.scopeKey,
			},
			clock: { atMs: NOW },
		});
		if (planned.status !== "planned") throw new Error("plan failed");
		applyForget(db, {
			contractVersion: CONTRACT_VERSIONS.lifecycle,
			entry: planned.plan.entry,
			clock: { atMs: NOW },
		});
		return {
			forgetId: planned.plan.entry.forgetId,
			entry: planned.plan.entry,
		};
	});
}

export function receiptOf(life: Life, forgetId: string) {
	return life.store.read((db) =>
		getForgetReceipt(db, {
			contractVersion: CONTRACT_VERSIONS.lifecycle,
			access: { ...ACCESS, policyRevision: memoryPolicyRevision(db) },
			forgetId,
		}),
	);
}

/** The eumenes-world external deletions of a Memory forget, by state. */
export function worldExternals(life: Life, forgetId: string) {
	const found = receiptOf(life, forgetId);
	if (found.status !== "found") return [];
	return found.receipt.externalDeletions
		.filter((item) => item.providerRef === "eumenes-world")
		.map((item) => ({ externalId: item.externalId, state: item.state }));
}

export const rows = (life: Life, table: string): number =>
	(
		life.store.read((db) =>
			db.query(`SELECT COUNT(*) AS n FROM ${table}`).get(),
		) as { n: number }
	).n;

export const intakeStates = (life: Life) =>
	life.store.read((db) =>
		db
			.query(
				"SELECT forget_id, state, origin FROM world_host_forget_intake ORDER BY rowid",
			)
			.all(),
	) as { forget_id: string; state: string; origin: string }[];
