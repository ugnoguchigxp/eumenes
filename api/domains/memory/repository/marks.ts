import type { Database } from "bun:sqlite";

/**
 * The marks of a State item the record itself cannot carry (spec/memory-recall-implementation-2026-11-23.md section
 * 2.2): the information is sensitive, or it is about someone or something else. The host's own table; it holds no
 * text. Appended after the others; frozen once deployed.
 */
export const itemMarksMigration = `
CREATE TABLE memory_item_mark (
 item_id TEXT PRIMARY KEY,
 sensitive INTEGER NOT NULL DEFAULT 0,
 about_other INTEGER NOT NULL DEFAULT 0
);
`;

export type ItemMarks = { sensitive: boolean; aboutOther: boolean };

/** Every mark (a row exists only for an item that has one). */
export function readMarks(db: Database): Map<string, ItemMarks> {
	const rows = db
		.query(
			"SELECT item_id AS itemId, sensitive, about_other AS aboutOther FROM memory_item_mark",
		)
		.all() as { itemId: string; sensitive: number; aboutOther: number }[];
	return new Map(
		rows.map((row) => [
			row.itemId,
			{ sensitive: row.sensitive === 1, aboutOther: row.aboutOther === 1 },
		]),
	);
}

/** The marks of the given items (an item with none has no entry). */
export function readMarksOf(
	db: Database,
	itemIds: readonly string[],
): Map<string, ItemMarks> {
	const found = new Map<string, ItemMarks>();
	for (let i = 0; i < itemIds.length; i += 500) {
		const chunk = itemIds.slice(i, i + 500);
		const rows = db
			.query(
				`SELECT item_id AS itemId, sensitive, about_other AS aboutOther FROM memory_item_mark
				 WHERE item_id IN (${chunk.map(() => "?").join(",")})`,
			)
			.all(...chunk) as {
			itemId: string;
			sensitive: number;
			aboutOther: number;
		}[];
		for (const row of rows)
			found.set(row.itemId, {
				sensitive: row.sensitive === 1,
				aboutOther: row.aboutOther === 1,
			});
	}
	return found;
}

/**
 * Adds marks to an item; a mark already there stays (marks are only ever added, never taken off). True when the item
 * has a mark it did not have before.
 */
export function putMarks(
	db: Database,
	itemId: string,
	marks: Partial<ItemMarks>,
): boolean {
	if (!marks.sensitive && !marks.aboutOther) return false;
	const before = db
		.query(
			"SELECT sensitive, about_other AS aboutOther FROM memory_item_mark WHERE item_id = ?",
		)
		.get(itemId) as { sensitive: number; aboutOther: number } | null;
	const added =
		(marks.sensitive === true && before?.sensitive !== 1) ||
		(marks.aboutOther === true && before?.aboutOther !== 1);
	if (!added) return false;
	db.query(
		`INSERT INTO memory_item_mark (item_id, sensitive, about_other) VALUES (?,?,?)
		 ON CONFLICT(item_id) DO UPDATE SET sensitive = MAX(sensitive, excluded.sensitive), about_other = MAX(about_other, excluded.about_other)`,
	).run(itemId, marks.sensitive ? 1 : 0, marks.aboutOther ? 1 : 0);
	return true;
}

/** A new version (or a merge) carries the marks of the versions it replaced. */
export function inheritMarks(
	db: Database,
	fromItemIds: readonly string[],
	toItemId: string,
) {
	const from = fromItemIds.filter((id) => id !== toItemId);
	if (from.length === 0) return;
	const row = db
		.query(
			`SELECT MAX(sensitive) AS sensitive, MAX(about_other) AS aboutOther FROM memory_item_mark
			 WHERE item_id IN (${from.map(() => "?").join(",")})`,
		)
		.get(...from) as { sensitive: number | null; aboutOther: number | null };
	putMarks(db, toItemId, {
		sensitive: row.sensitive === 1,
		aboutOther: row.aboutOther === 1,
	});
}

/** The forget purge: the marks of forgotten items go. */
export function purgeMarks(db: Database, itemIds: readonly string[]) {
	for (const itemId of itemIds)
		db.query("DELETE FROM memory_item_mark WHERE item_id = ?").run(itemId);
}
