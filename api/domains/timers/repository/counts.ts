import type { Database } from "bun:sqlite";
export function countTimers(db: Database, scope: string): number {
	return (
		db.query("SELECT COUNT(*) AS n FROM timers WHERE scope=?").get(scope) as {
			n: number;
		}
	).n;
}

export function countOperations(db: Database, scope: string): number {
	return (
		db
			.query(
				"SELECT COUNT(*) AS n FROM timer_operations WHERE scope=? AND operation!='list'",
			)
			.get(scope) as { n: number }
	).n;
}

export function countListOperations(db: Database, scope: string): number {
	return (
		db
			.query(
				"SELECT COUNT(*) AS n FROM timer_operations WHERE scope=? AND operation='list'",
			)
			.get(scope) as { n: number }
	).n;
}
