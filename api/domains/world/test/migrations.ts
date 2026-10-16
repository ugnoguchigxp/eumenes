import { migrations as memoryPackageSql } from "eumenes-memory/sqlite";
import { migrations as worldPackageSql } from "eumenes-world-model/sqlite";
import {
	orderMigrations,
	type Migration,
} from "../../../infrastructure/sqlite";
import { migrations as conversationMigrations } from "../../conversation";
import { migrations as goalsMigrations } from "../../goals";
import { migrations as memoryMigrations } from "../../memory";
import { migrations as worldMigrations } from "..";

const packaged = (owner: string, sqls: readonly string[]): Migration[] =>
	sqls.map((sql, i) => ({
		id: `${owner}/${String(i + 1).padStart(4, "0")}`,
		sql,
	}));

/**
 * The schema the World host tests run on: the tables of every domain World reads or writes
 * (Conversation, Memory with its package, Goals, the World package) and World's own. It is listed
 * from the domains' public entries, in dependency order.
 */
export const migrations: readonly Migration[] = orderMigrations([
	...conversationMigrations,
	...memoryMigrations,
	...packaged("memory-package", memoryPackageSql),
	...packaged("world-package", worldPackageSql),
	...goalsMigrations,
	...worldMigrations,
]);
