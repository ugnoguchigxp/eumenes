import type { Database } from "bun:sqlite";
import type {
	ConsolidationConfig,
	GoalInput,
	GoalInstruction,
	PrepInstruction,
	Relink,
	TendencyWrite,
	UnresolvedConflict,
} from "eumenes-consolidation";
import type { SleepWindow } from "./policy";

/**
 * Where the sleep layer's instructions go (the memory redesign, sections 6 and 9). Each outlet runs inside the
 * unit's settle transaction, so an outlet that throws leaves the unit failed and its instructions unapplied.
 */
export interface SleepOutlets {
	/** Open plans past their date wait for the user's confirmation (`continuity`'s L3). `localNow`: `YYYY-MM-DDTHH:MM`. */
	plansDue(db: Database, localNow: string): void;
	/** Closed plans untouched for the retention time go. */
	pruneClosedPlans(db: Database): void;
	/** Contradictions neither side of which is changed: saved as open questions of `continuity` for the agent to ask. */
	unresolved(db: Database, items: readonly UnresolvedConflict[]): void;
	/** Short preparations for topics likely to continue (stored by the host as a supplement of L3). */
	prep(db: Database, items: readonly PrepInstruction[]): void;
	/**
	 * Goals the records suggest the user should be asked about (the sleep layer never changes a goal): saved as open
	 * questions of `continuity`. `goals` are the ones the run was shown, with the texts the questions quote.
	 */
	goals(
		db: Database,
		items: readonly GoalInstruction[],
		goals: readonly GoalInput[],
	): void;
	/** A version change that kept the meaning: references move from the old item to the new one (the agent follows the memory's change feed; kept in the log here). */
	relinks(db: Database, items: readonly Relink[]): void;
	/**
	 * Writes a tendency (L4). Called by the library inside the transaction that promotes the other candidates and
	 * dismisses this candidate: a throw rolls the whole deep run back.
	 */
	writeTendency(db: Database, tendency: TendencyWrite): void;
}

/** What the application gives the steward for the sleep layer. */
export interface SleepDeps {
	/** The time window deep consolidation is pulled into (a saved setting), read at each use. */
	window(): SleepWindow;
	/** The library's thresholds; the library's own defaults when absent. */
	config?: ConsolidationConfig;
	/** Replaces some outlets (the default ones write plans through `continuity` and log the rest). */
	outlets?: Partial<SleepOutlets>;
}
