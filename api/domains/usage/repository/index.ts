import type { Database } from "bun:sqlite";
import type { Migration } from "../../../infrastructure/sqlite";
import type { Rate } from "../contracts";
export const migrations: readonly Migration[] = [
	{
		id: "usage/0001-rates",
		after: ["live-voice/0002-usage", "inference/0014-usage"],
		sql: `
CREATE TABLE usage_rates(id TEXT PRIMARY KEY,model TEXT NOT NULL,amount TEXT NOT NULL,effective_from TEXT NOT NULL,source TEXT NOT NULL,checked_at TEXT NOT NULL,UNIQUE(model,effective_from));
CREATE TABLE usage_operations(id TEXT PRIMARY KEY,receipt TEXT NOT NULL);
`,
	},
];
export const rateRevision = (db: Database) =>
	(db.query("SELECT count(*) AS n FROM usage_rates").get() as { n: number }).n;
export const ratesInTransaction = (db: Database) =>
	db
		.query(
			"SELECT id,model,amount,effective_from AS effectiveFrom,source,checked_at AS checkedAt FROM usage_rates ORDER BY effective_from DESC,id",
		)
		.all() as Rate[];
