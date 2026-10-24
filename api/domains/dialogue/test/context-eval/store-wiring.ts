/**
 * Real services on a temp SQLite store for the context-eval session: the product's conversation, continuity and
 * memory services over the same migrations the application runs. Lives in test/ because it reaches domains below
 * dialogue's own dependencies; the CLI imports it too.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrations as memoryPackageMigrations } from "eumenes-memory/sqlite";
import { configureLogging } from "../../../../infrastructure/logger";
import { openStore } from "../../../../infrastructure/sqlite";
import {
	createContinuityService,
	migrations as continuityMigrations,
} from "../../../continuity";
import {
	createConversationService,
	migrations as conversationMigrations,
} from "../../../conversation";
import {
	createMemoryService,
	migrations as memoryMigrations,
} from "../../../memory";
import { migrations as dialogueMigrations } from "../..";
import { DEFAULT_START, type SeedWiring } from "../../eval/context/session";

/** Opens an isolated store; `close()` removes it. */
export async function openSeedWiring(): Promise<SeedWiring> {
	configureLogging({ level: "silent" });
	const dir = mkdtempSync(join(tmpdir(), "eumenes-context-eval-"));
	const store = openStore(join(dir, "db.sqlite3"), [
		...conversationMigrations,
		...continuityMigrations,
		...memoryMigrations,
		...memoryPackageMigrations,
		...dialogueMigrations,
	]);
	const conversation = createConversationService(store);
	let now = DEFAULT_START;
	let counter = 0;
	const id = () =>
		`11111111-0000-4000-8000-${String(++counter).padStart(12, "0")}`;
	const continuity = createContinuityService(store, () => now, id);
	const memory = createMemoryService(store, conversation, continuity, {
		journalPath: join(dir, "journal.jsonl"),
		clock: () => now,
		id,
	});
	const close = async () => {
		await store.close().catch(() => {});
		rmSync(dir, { recursive: true, force: true });
	};
	if (!(await memory.recover()).healthy) {
		await close();
		throw new Error("context_eval_memory_unhealthy");
	}
	return {
		store,
		conversation,
		continuity,
		memory,
		setNow: (iso) => {
			now = iso;
		},
		now: () => now,
		close,
	};
}
