import { afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type SqliteStore } from "../../../infrastructure/sqlite";
import { createKanban, migrations } from "..";

const dirs: string[] = [];
export const stores: SqliteStore[] = [];
afterEach(async () => {
	for (const store of stores.splice(0)) await store.close();
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

/** The kanban migrations follow the queue's first migration; a stub stands in for it. */
export function openKanban() {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-kanban-"));
	dirs.push(dir);
	const file = join(dir, "db.sqlite3");
	const store = openStore(file, [
		{ id: "queue/0001-init", sql: "SELECT 1" },
		...migrations,
	]);
	stores.push(store);
	let tick = Date.parse("2026-10-14T00:00:00.000Z");
	let seq = 0;
	const kanban = createKanban({
		store,
		now: () => (tick += 1000),
		id: () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`,
	});
	return { store, kanban, file };
}
