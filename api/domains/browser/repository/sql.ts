import type { Database } from "bun:sqlite";

/** `UPDATE table SET <changed columns>, revision = revision + 1`; `table` and the column names are constants of this domain. */
export function patchRow(
	db: Database,
	table: string,
	keyColumn: string,
	key: string,
	change: Record<string, string | number | null>,
	now: number,
) {
	const columns = Object.keys(change);
	db.query(
		`UPDATE ${table} SET ${columns.map((c) => `${c}=?`).join(",")}${columns.length ? "," : ""} revision=revision+1, updated_at=? WHERE ${keyColumn}=?`,
	).run(...columns.map((c) => change[c] ?? null), now, key);
}
