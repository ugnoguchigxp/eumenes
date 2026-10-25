import type { Database } from "bun:sqlite";
import type { WorkRow } from ".";

/** A work with the time it was created: its first version (the work's own `updated_at` moves with every edit). */
export type ResourceWork = { row: WorkRow; createdAt: number };

const SELECT = `SELECT w.*, COALESCE((SELECT v.created_at FROM pipeline_work_versions v
 WHERE v.work_id=w.id AND v.revision=0), w.updated_at) AS resource_created_at FROM pipeline_works w`;

type Raw = WorkRow & { resource_created_at: number };
const of = ({ resource_created_at, ...row }: Raw): ResourceWork => ({
	row,
	createdAt: resource_created_at,
});

export function resourceWork(db: Database, id: string): ResourceWork | null {
	const raw = db.query(`${SELECT} WHERE w.id=?`).get(id) as Raw | null;
	return raw ? of(raw) : null;
}

/** The newest work that was opened from or published as this toolchain. */
export function resourceWorkOfTarget(
	db: Database,
	toolchainId: string,
): ResourceWork | null {
	const raw = db
		.query(`${SELECT} WHERE w.target_id=? ORDER BY w.updated_at DESC LIMIT 1`)
		.get(toolchainId) as Raw | null;
	return raw ? of(raw) : null;
}

export const resourceWorks = (db: Database): ResourceWork[] =>
	(
		db
			.query(`${SELECT} ORDER BY resource_created_at DESC, w.rowid DESC`)
			.all() as Raw[]
	).map(of);
