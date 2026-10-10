import type { Migration } from "../../../infrastructure/sqlite";
import { extractionMigration } from "./extraction";
import { extractionHoldMigration } from "./extraction-hold";
import { gapTaskMigration } from "./gap-task";
import { guardMigration } from "./guard";
import { hostStateMigration } from "./index";
import { lifecycleMigration } from "./lifecycle";
import { runtimeMigration } from "./runtime";
import { usageMigration } from "./usage";

/** Host-owned World tables; the SQL in the sibling files is frozen once deployed. */
export const migrations: readonly Migration[] = [
	{ id: "world/0001-host-state", sql: hostStateMigration },
	{ id: "world/0002-lifecycle", sql: lifecycleMigration },
	{ id: "world/0003-usage", sql: usageMigration },
	{ id: "world/0004-guard", sql: guardMigration },
	{ id: "world/0005-extraction", sql: extractionMigration },
	{ id: "world/0006-runtime", sql: runtimeMigration },
	{ id: "world/0007-gap-task", sql: gapTaskMigration },
	{
		id: "world/0008-extraction-hold",
		after: ["world/0007-gap-task"],
		sql: extractionHoldMigration,
	},
];
