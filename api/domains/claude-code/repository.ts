import type { Database } from "bun:sqlite";
import type { Migration } from "../../infrastructure/sqlite";
import type { Work } from "./contracts";

export const migrations: readonly Migration[] = [
	{
		id: "claude-code/0001-work",
		after: ["queue/0001-init"],
		sql: `
CREATE TABLE claude_code_work(
 id TEXT PRIMARY KEY,
 pending INTEGER NOT NULL,
 updated_at INTEGER NOT NULL,
 data TEXT NOT NULL
);
CREATE INDEX claude_code_work_pending ON claude_code_work(pending, updated_at);
`,
	},
	{
		id: "claude-code/0002-supervised-operations",
		after: ["claude-code/0001-work"],
		sql: `CREATE TABLE claude_code_supervised_operations(
 id TEXT PRIMARY KEY,
 work_id TEXT NOT NULL REFERENCES claude_code_work(id),
 digest TEXT NOT NULL
);`,
	},
];

export function operation(db: Database, id: string) {
	return db
		.query<{ workId: string; digest: string }, [string]>(
			"SELECT work_id AS workId,digest FROM claude_code_supervised_operations WHERE id=?",
		)
		.get(id);
}

export function recordOperation(
	db: Database,
	id: string,
	workId: string,
	digest: string,
) {
	db.query("INSERT INTO claude_code_supervised_operations VALUES(?,?,?)").run(
		id,
		workId,
		digest,
	);
}

export function read(db: Database, id: string): Work | null {
	const row = db
		.query<{ data: string }, [string]>(
			"SELECT data FROM claude_code_work WHERE id=?",
		)
		.get(id);
	return row ? (JSON.parse(row.data) as Work) : null;
}

export function terminal(work: Work) {
	return [
		"completed",
		"partial",
		"failed",
		"cancelled",
		"interrupted",
	].includes(work.status);
}

export function save(db: Database, work: Work, now: number) {
	work.revision++;
	db.query(
		`INSERT INTO claude_code_work VALUES(?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET pending=excluded.pending, updated_at=excluded.updated_at, data=excluded.data`,
	).run(
		work.id,
		Number(
			!terminal(work) ||
				!!work.notice ||
				!!work.effect ||
				(!!work.supervision && work.stop === "unconfirmed"),
		),
		now,
		JSON.stringify(work),
	);
}

export function pending(db: Database): Work[] {
	return db
		.query<{ data: string }, []>(
			"SELECT data FROM claude_code_work WHERE pending=1 ORDER BY updated_at",
		)
		.all()
		.map(({ data }) => JSON.parse(data) as Work);
}
