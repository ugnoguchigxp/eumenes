import type { Database } from "bun:sqlite";

const EXECUTABLE = "executable_path";

export function executablePath(db: Database) {
	const r = db
		.query("SELECT value FROM browser_settings WHERE key=?")
		.get(EXECUTABLE) as { value: string } | null;
	return r?.value || null;
}

/** An empty path clears the setting. */
export function saveExecutablePath(db: Database, path: string, now: number) {
	if (!path) {
		db.query("DELETE FROM browser_settings WHERE key=?").run(EXECUTABLE);
		return;
	}
	db.query(
		`INSERT INTO browser_settings(key,value,updated_at) VALUES(?,?,?)
		 ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
	).run(EXECUTABLE, path, now);
}
