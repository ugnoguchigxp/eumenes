/**
 * Real services on a temp SQLite store for the context-eval materializer (the same wiring as
 * context-compiler.test.ts `setup()`). Lives in test/ because it reaches domains below dialogue's own dependencies.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configureLogging } from "../../../../infrastructure/logger";
import { openStore } from "../../../../infrastructure/sqlite";
import { createContinuityService } from "../../../continuity";
import { createConversationService } from "../../../conversation";
import { createMemoryService } from "../../../memory";
import {
	agentLinkMigration,
	migration,
	queueLinkMigration,
	worldStateMigration,
} from "../..";
import type { SeedWiring } from "../../eval/context/materialize";
import { addNote, memoryMigrations, saveItem } from "../memory-seed";

const FIXED_TIME = "2026-10-13T00:00:00.000Z";

/** Opens an isolated store; `close()` removes it. */
export async function openSeedWiring(): Promise<SeedWiring> {
	configureLogging({ level: "silent" });
	const dir = mkdtempSync(join(tmpdir(), "eumenes-context-eval-"));
	const store = openStore(join(dir, "db.sqlite3"), [
		...memoryMigrations,
		migration,
		queueLinkMigration,
		agentLinkMigration,
		worldStateMigration,
	]);
	const conversation = createConversationService(store);
	const continuity = createContinuityService(store, () => FIXED_TIME);
	let counter = 0;
	const memory = createMemoryService(store, conversation, continuity, {
		journalPath: join(dir, "journal.jsonl"),
		clock: () => FIXED_TIME,
		id: () => `id-${++counter}`,
	});
	if (!(await memory.recover()).healthy) {
		await store.close().catch(() => {});
		rmSync(dir, { recursive: true, force: true });
		throw new Error("context_eval_memory_unhealthy");
	}
	return {
		store,
		conversation,
		memory,
		saveItem: (input) => saveItem(store, memory, input),
		addNote: (conversationId, input) =>
			addNote(store, continuity, conversationId, input),
		async close() {
			await store.close().catch(() => {});
			rmSync(dir, { recursive: true, force: true });
		},
	};
}
