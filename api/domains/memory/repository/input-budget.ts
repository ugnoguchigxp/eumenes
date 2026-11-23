import type { Database } from "bun:sqlite";
import type { MemoryInputBudget } from "../contracts/recall";

/**
 * The input budget lives in the host settings row (spec/memory-recall-implementation-2026-11-23.md section 5): the
 * values are these column defaults and what the settings API saves, never constants of the code. Appended after the
 * others; frozen once deployed.
 */
export const inputBudgetMigration = `
ALTER TABLE memory_host_settings ADD COLUMN always_tokens INTEGER NOT NULL DEFAULT 2000;
ALTER TABLE memory_host_settings ADD COLUMN always_scope TEXT NOT NULL DEFAULT 'facts';
ALTER TABLE memory_host_settings ADD COLUMN recall_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE memory_host_settings ADD COLUMN recall_tokens INTEGER NOT NULL DEFAULT 400;
ALTER TABLE memory_host_settings ADD COLUMN recall_items INTEGER NOT NULL DEFAULT 8;
`;

export function readInputBudget(db: Database): MemoryInputBudget {
	const row = db
		.query(
			`SELECT always_tokens AS alwaysTokens, always_scope AS alwaysScope, recall_enabled AS recallEnabled,
			 recall_tokens AS recallTokens, recall_items AS recallItems FROM memory_host_settings WHERE id = 1`,
		)
		.get() as Omit<MemoryInputBudget, "recallEnabled"> & {
		recallEnabled: number;
	};
	return { ...row, recallEnabled: row.recallEnabled === 1 };
}
