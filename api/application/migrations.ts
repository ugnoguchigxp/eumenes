import type { Migration } from "../infrastructure/sqlite";
import { orderMigrations } from "../infrastructure/sqlite";
import { migrations as agentRuntimeMigrations } from "../domains/agent-runtime";
import { migrations as capabilitiesMigrations } from "../domains/capabilities";
import { migrations as codingMigrations } from "../domains/coding";
import { migrations as supervisionMigrations } from "../domains/coding-supervision";
import { migrations as continuityMigrations } from "../domains/continuity";
import { migrations as conversationMigrations } from "../domains/conversation";
import { migrations as dialogueMigrations } from "../domains/dialogue";
import { migrations as goalsMigrations } from "../domains/goals";
import { migrations as inferenceMigrations } from "../domains/inference";
import { migrations as memoryMigrations } from "../domains/memory";
import { migrations as queueMigrations } from "../domains/queue";
import { migrations as researchRoutesMigrations } from "../domains/research-routes";
import { migrations as schedulerMigrations } from "../domains/scheduler";
import { migrations as serviceTestsMigrations } from "../domains/service-tests";
import { migrations as settingsMigrations } from "../domains/settings";
import { migrations as taskReportsMigrations } from "../domains/task-reports";
import { migrations as dotsMigrations } from "../domains/dots";
import { migrations as tasksMigrations } from "../domains/tasks";
import { migrations as timersMigrations } from "../domains/timers";
import { migrations as toolRuntimeMigrations } from "../domains/tool-runtime";
import { migrations as ttsDictionaryMigrations } from "../domains/tts-dictionary";
import { migrations as voiceMigrations } from "../domains/voice-dialogue";
import { migrations as webResearchMigrations } from "../domains/web-research";
import { migrations as worldMigrations } from "../domains/world";
import { migrations as memoryPackageSql } from "eumenes-memory/sqlite";
import { migrations as worldPackageSql } from "eumenes-world-model/sqlite";

/**
 * The positional order the databases deployed before 2026-10-10 were built in. Row N of the old
 * `schema_migrations` table means `legacyOrder[N - 1]`. FROZEN: never reorder, insert into, or
 * edit this list (the golden test pins it). Anything added later is NOT listed here; it declares
 * `after` instead.
 */
export const legacyOrder: readonly string[] = [
	"conversation/0001-init",
	"dialogue/0001-init",
	"voice-dialogue/0001-init",
	"queue/0001-init",
	"scheduler/0001-init",
	"dialogue/0002-queue-link",
	"voice-dialogue/0002-sequence",
	// The earlier bookmark-style continuity domain was retired; its slot stays a no-op and its
	// old tables are left untouched. The new `continuity` domain has its own tables.
	"continuity-legacy/0001-retired",
	"settings/0001-init",
	"inference/0001-init",
	"settings/0002-epochs",
	"inference/0002-parents",
	"inference/0003-diagnostics",
	"tts-dictionary/0001-init",
	"conversation/0002-avatar-motion",
	"conversation/0003-answer-delivery",
	"continuity/0001-init",
	"memory/0001-init",
	"memory-package/0001",
	"memory-package/0002",
	"memory-package/0003",
	"memory-package/0004",
	"service-tests/0001-init",
	"memory-package/0005",
	"web-research/0001-init",
	"memory-package/0006",
	"capabilities/0001-init",
	"tool-runtime/0001-init",
	"agent-runtime/0001-init",
	"inference/0004-control",
	"dialogue/0003-agent-link",
	"conversation/0004-outbox",
	"goals/0001-init",
	"tasks/0001-init",
	"conversation/0005-retraction",
	"goals/0002-operation",
	"capabilities/0002-learned",
	"agent-runtime/0002-acquisition",
	"research-routes/0001-init",
	"web-research/0002-attempt-timeout",
	"tool-runtime/0002-route-grant",
	"tool-runtime/0003-supersede",
	"world-package/0001",
	"world-package/0002",
	"world-package/0003",
	"world-package/0004",
	"world-package/0005",
	"world-package/0006",
	"world-package/0007",
	"world/0001-host-state",
	"world/0002-lifecycle",
	"world/0003-usage",
	"timers/0001-init",
	"agent-runtime/0003-action-result",
	"tool-runtime/0004-action",
	"coding/0001-init",
	"world/0004-guard",
	"dialogue/0004-world-state",
	"inference/0005-background-control",
	"task-reports/0001-init",
	"coding-supervision/0001-init",
	"world/0005-extraction",
	"world/0006-runtime",
	"world/0007-gap-task",
];

const retiredContinuityMigration: Migration = {
	id: "continuity-legacy/0001-retired",
	sql: "SELECT 1",
};

/**
 * A package's migrations are an ordered list without names: they are named by position. The
 * ones deployed before the freeze keep their implicit place in `legacyOrder`; a later one runs
 * after the package migration before it.
 */
function packageMigrations(
	owner: string,
	sqls: readonly string[],
): Migration[] {
	const ids = sqls.map((_, i) => `${owner}/${String(i + 1).padStart(4, "0")}`);
	return sqls.map((sql, i) => {
		const id = ids[i] as string;
		return legacyOrder.includes(id)
			? { id, sql }
			: { id, sql, after: [ids[i - 1] as string] };
	});
}

/** Every migration of the product, in no meaningful order. */
const catalog: readonly Migration[] = [
	retiredContinuityMigration,
	...conversationMigrations,
	...dialogueMigrations,
	...voiceMigrations,
	...queueMigrations,
	...schedulerMigrations,
	...settingsMigrations,
	...inferenceMigrations,
	...ttsDictionaryMigrations,
	...continuityMigrations,
	...memoryMigrations,
	...packageMigrations("memory-package", memoryPackageSql),
	...serviceTestsMigrations,
	...webResearchMigrations,
	...capabilitiesMigrations,
	...toolRuntimeMigrations,
	...agentRuntimeMigrations,
	...goalsMigrations,
	...tasksMigrations,
	...dotsMigrations,
	...researchRoutesMigrations,
	...packageMigrations("world-package", worldPackageSql),
	...worldMigrations,
	...timersMigrations,
	...codingMigrations,
	...taskReportsMigrations,
	...supervisionMigrations,
];

/**
 * Legacy migrations depend on their predecessor in `legacyOrder`, which reproduces the
 * deployed order exactly. Every other migration must declare `after` itself.
 */
function resolve(all: readonly Migration[]): Migration[] {
	const byId = new Map(all.map((m) => [m.id, m]));
	if (byId.size !== all.length) throw new Error("migration_duplicate_id");
	const legacy = legacyOrder.map((id, i) => {
		const m = byId.get(id);
		if (!m) throw new Error(`migration_legacy_missing:${id}`);
		const previous = legacyOrder[i - 1];
		return { ...m, after: m.after ?? (previous ? [previous] : []) };
	});
	const added = all
		.filter((m) => !legacyOrder.includes(m.id))
		.map((m) => {
			if (!m.after?.length) throw new Error(`migration_after_required:${m.id}`);
			return { ...m, after: [...m.after, legacyOrder.at(-1)!] };
		});
	return orderMigrations([...legacy, ...added]);
}

/** Everything, ordered topologically (for the frozen part: exactly the legacy order). */
export const migrations: readonly Migration[] = resolve(catalog);
/** The original host block: the first 18 legacy migrations. */
export const hostMigrations: readonly Migration[] = migrations.slice(0, 18);
