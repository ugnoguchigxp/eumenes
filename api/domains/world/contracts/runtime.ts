import type { Database } from "bun:sqlite";
import type { AccessContext } from "eumenes-memory";
import type { SourceKey } from "./index";

/**
 * Runtime result observation (P4-04). The OWNER of the execution ledger
 * (tool-runtime / agent-runtime / capabilities) decides whether a tool
 * execution succeeded and whether its result was verified. World never does:
 * it reads a snapshot through this port and only adds the semantic judgement
 * (supports / refutes / incomparable) of a prediction against it.
 *
 * STATUS: no public execution ledger with verified, comparable measurements
 * exists in the host (its tool_invocations / agent_action_results / timer
 * receipts carry no comparisonId, metric, unit, configuration or baseline).
 * This port is therefore implemented by FIXTURES ONLY; connecting the real
 * owner is a separate ticket and until then the ticket is NOT accepted.
 */
export const WORLD_RUNTIME_PURPOSE = "world.runtime";

/** What the ledger says about its own verification. Only "verified" ever becomes an observation. */
export type RuntimeVerification = "verified" | "unverified" | "failed";

/**
 * The comparison facts of one measured result. Every field is optional on the
 * wire: a ledger that did not record one leaves it out, and World then calls
 * the result incomparable instead of guessing it.
 */
export type RuntimeMeasurement = {
	comparisonId?: string;
	subjectId?: string;
	metric?: string;
	unit?: string;
	/** "avg", "p95", ... Different statistics are never compared. */
	statistic?: string;
	/** The configuration under which the result was produced. */
	configuration?: string;
	/** Workload / input size description. */
	inputProfile?: string;
	baselineRef?: string;
	/** Half-open [startMs, endMs) the measurement covers. */
	window?: { startMs: number; endMs: number };
	value?: number;
};

export type RuntimeSnapshot =
	| {
			status: "available";
			source: SourceKey;
			/**
			 * The ledger's version of this result and a digest that covers the
			 * result AND its verification state: a correction or a change of the
			 * verification state is a new revision/digest. Opaque to World.
			 */
			revision: string;
			digest: string;
			principal: string;
			scopeKey: string;
			verification: { state: RuntimeVerification };
			measurement: RuntimeMeasurement;
			/** UTC epoch ms the ledger recorded the measurement. */
			observedAt: number;
	  }
	| {
			status: "missing";
			source: SourceKey;
			reason: "not_found" | "retracted" | "forgotten";
	  };

/** Implemented by the owning ledger's public snapshot. Synchronous, on a borrowed connection. */
export interface RuntimeLedgerPort {
	readonly namespace: string;
	readCurrent(
		db: Database,
		access: AccessContext,
		key: SourceKey,
	): RuntimeSnapshot;
}
