import type { SqliteStore } from "../../../infrastructure/sqlite";
import type { RuntimeLedgerPort } from "../contracts";
import type { RuntimeObservationRow } from "../repository/runtime";
import type { AssessResult } from "eumenes-world-model";
import type {
	ForgetRefusal,
	ForgetReport,
	ForgetRequest,
} from "./lifecycle-adapter";
import type { MemoryPort } from "./lifecycle-memory";
import type { registerWorldDependents } from "./memory-adapter";
import type { WorldService } from "./world-service";

export type RuntimeObservationOptions = {
	store: SqliteStore;
	world: WorldService;
	ledger: RuntimeLedgerPort;
	/** Forget procedure for withdrawn Outcomes; without it `reconcile` can only report. */
	lifecycle?: {
		acceptForget(request: ForgetRequest): Promise<ForgetReport | ForgetRefusal>;
	};
	purpose?: string;
	clock?: () => number;
	/** Replace single Memory calls (tests); production uses the public API only. */
	memory?: Partial<MemoryPort>;
	/** Test seam for the Memory dependent registration (the default is the real public API). */
	register?: typeof registerWorldDependents;
};

const RUNTIME_REFUSALS = [
	"LEDGER_UNAVAILABLE",
	"NOT_VERIFIED",
	"SCOPE_MISMATCH",
] as const;
export type RuntimeRefusal = (typeof RUNTIME_REFUSALS)[number];

export type PredictionRef = { predictionId: string; revision: number };

export type LedgerVersion = {
	sourceKey: string;
	revision: string;
	digest: string;
};

export type ObserveResult =
	| {
			status: "observed";
			outcome: { id: string; revision: number };
			ledger: LedgerVersion;
	  }
	| {
			/** The same ledger version was already seen for this Prediction: nothing changed. */
			status: "duplicate";
			state: RuntimeObservationRow["state"];
			outcome: { id: string; revision: number } | null;
			ledger: LedgerVersion;
	  }
	| {
			status: "incomparable";
			reasons: string[];
			ledger: LedgerVersion;
	  }
	| { status: "refused"; reasonCode: RuntimeRefusal }
	| {
			/** World / Memory refused or could not take it; nothing was written. */
			status: "rejected" | "blocked";
			reasonCode: string;
			stage: "world" | "memory";
	  };

export type AssessedObservations = {
	/** The package's verdict. With no usable observation it is `incomparable` with zero counts. */
	assessed: AssessResult;
	/** Which verified ledger version each judged Outcome stands on. */
	trace: {
		outcome: { id: string; revision: number };
		ledger: LedgerVersion;
	}[];
	/** Verified results that could not be compared at all (conditions missing / not matching). */
	incomparable: { ledger: LedgerVersion; reasons: string[] }[];
	/** Recorded observations whose ledger version is no longer current & verified: NOT judged. */
	stale: number;
};

export type ReconcileReport = {
	checked: number;
	unchanged: number;
	/** A later verified ledger revision was observed as the next Outcome revision. */
	corrected: number;
	/** The ledger forgot / retracted / un-verified the result: the Outcome went to the forget procedure. */
	withdrawn: number;
	/** Withdrawals that could not be started (no lifecycle, refused, Memory unavailable): retried by the next call. */
	pending: number;
};
