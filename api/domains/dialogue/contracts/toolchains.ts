import type { Database } from "bun:sqlite";
import type {
	FixedDefinition,
	ToolchainCard,
	ToolchainRuntimeMeta,
	VectorSpace,
} from "../../capabilities";
import type {
	PastSelection,
	Selection,
	SelectionCandidate,
	SelectionDecision,
	SelectionOutcome,
} from "../../toolchain-history";

export type QueryVector = { space: VectorSpace; vector: number[] };

/** The candidates and reference data for one conversation decision. */
export type ToolchainRoute = {
	cards: ToolchainCard[];
	past: PastSelection[];
	retrieval: Selection["retrieval"];
};

/**
 * What dialogue needs from the toolchain registry and the selection history. Retrieval only
 * narrows the offer; the conversation model chooses, and the toolchain's sub-agent executes.
 */
export interface ToolchainRoutingPort {
	/** A query embedding of the request, or undefined when the provider is unavailable or slow. */
	embedQuery(
		text: string,
		signal: AbortSignal,
	): Promise<QueryVector | undefined>;
	routeInTransaction(
		db: Database,
		input: {
			runId: string;
			text: string;
			query?: QueryVector;
			available: ReadonlySet<string>;
		},
	): ToolchainRoute;
	resolveInTransaction(
		db: Database,
		revisionId: string,
	): {
		toolchain: FixedDefinition;
		packageRevisionId: string;
		runtime: ToolchainRuntimeMeta;
	};
	/** The fixed set a command sub-agent loads (profile, SKILL, tool details). */
	commandSetInTransaction(
		db: Database,
		revisionId: string,
	): {
		backend: string | undefined;
		profile: string;
		skills: string[];
		tools: Array<{
			id: string;
			revisionId: string;
			summary: string;
			schema: Record<string, unknown> | null;
		}>;
	};
	recordSelectionInTransaction(
		db: Database,
		input: {
			runId: string;
			conversationId: string;
			utteranceId?: string | null;
			requestId?: string | null;
			retrieval: Selection["retrieval"];
			candidates: SelectionCandidate[];
			historyRefs: string[];
			decision: SelectionDecision;
			toolchainId?: string;
			toolchainRevisionId?: string;
			functionName?: string;
			request?: string;
			repaired?: boolean;
			query?: QueryVector;
			durationMs?: number;
		},
	): string;
	linkTaskInTransaction(db: Database, runId: string, taskId: string): void;
	settleSelectionInTransaction(
		db: Database,
		runId: string,
		result: { outcome: SelectionOutcome; code?: string | null },
	): void;
	/** The request text the conversation handed to the toolchain of a run. */
	requestOfRunInTransaction(db: Database, runId: string): string | undefined;
}
