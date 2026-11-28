import type { Database } from "bun:sqlite";
import type { MemoryInputBudget } from "../contracts/recall";

/**
 * The input budget lives in the host settings row (spec/.archived/memory-recall-implementation-2026-11-23.md section 5): the
 * values are these column defaults and what the settings API saves, never constants of the code. Appended after the
 * others; frozen once deployed. The `recall_*` columns stay in the table (the per-turn `## Recall` section was
 * removed): nothing reads or writes them.
 */
export const inputBudgetMigration = `
ALTER TABLE memory_host_settings ADD COLUMN always_tokens INTEGER NOT NULL DEFAULT 2000;
ALTER TABLE memory_host_settings ADD COLUMN always_scope TEXT NOT NULL DEFAULT 'facts';
ALTER TABLE memory_host_settings ADD COLUMN recall_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE memory_host_settings ADD COLUMN recall_tokens INTEGER NOT NULL DEFAULT 400;
ALTER TABLE memory_host_settings ADD COLUMN recall_items INTEGER NOT NULL DEFAULT 8;
`;

/**
 * The size-first input (spec/.todo/conversation-input-size-budget-design-2026-11-28.md section 7): `## Memory` holds
 * only what steers every reply (the user's constraints and preferences) within 100 tokens; the rest is read with
 * `read_memory`. A saved bound above it is lowered once; the settings API can still set another value.
 */
export const sizeFirstInputBudgetMigration = `
UPDATE memory_host_settings SET always_tokens = 100 WHERE always_tokens > 100;
UPDATE memory_host_settings SET always_scope = 'responses';
`;

export function readInputBudget(db: Database): MemoryInputBudget {
	return db
		.query(
			"SELECT always_tokens AS alwaysTokens, always_scope AS alwaysScope FROM memory_host_settings WHERE id = 1",
		)
		.get() as MemoryInputBudget;
}
