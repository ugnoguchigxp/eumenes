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
	SelectionAnalysis,
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
			excludeRevisionIds?: ReadonlySet<string>;
			/** Discovery must not expand the catalog when embedding retrieval fails. */
			strict?: boolean;
		},
	): ToolchainRoute;
	/** Rebuild a callable card from its exact active revision without retrieval. */
	cardInTransaction(
		db: Database,
		revisionId: string,
	): ToolchainCard | undefined;
	resolveInTransaction(
		db: Database,
		revisionId: string,
	): {
		toolchain: FixedDefinition;
		packageRevisionId: string;
		runtime: ToolchainRuntimeMeta;
	};
	/**
	 * Every active toolchain with its host runtime: the fixed map for unbound chains, the binding
	 * and adapter availability for bound ones. Replaces the builtin array as the offer source.
	 */
	catalogInTransaction(
		db: Database,
	): Array<{ id: string; revisionId: string; runtime: ToolchainRuntimeMeta }>;
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
		/** Present for bound command toolchains: tools map to adapter operations. */
		binding?: BoundCommandSet;
	};
	/** Host services of bound command toolchains (adapter snapshot, input checks, preparation). */
	bound?: BoundCommandPort;
	/** The run of an instant-answer toolchain revision; undefined for any other (or an unavailable one). */
	instantInTransaction?(
		db: Database,
		revisionId: string,
	): InstantRun | undefined;
	/**
	 * The session toolchain a specialist runs with (spec toolchain-specialist-dialogue §4.1).
	 * Throws `capability_unavailable` for a non-session or unavailable toolchain.
	 */
	sessionSetInTransaction?(
		db: Database,
		toolchainRevisionId: string,
	): import("./specialist").SpecialistSet;
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
			analysis?: SelectionAnalysis;
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
	/** Optional status metadata for a usage reference; no output body or prior approval is exposed. */
	usageOfRunInTransaction?(
		db: Database,
		runId: string,
	):
		| {
				selectionId: string;
				request: string | null;
				outcome: SelectionOutcome | null;
				code: string | null;
		  }
		| undefined;
	/** The request text the conversation handed to the toolchain of a run. */
	requestOfRunInTransaction(db: Database, runId: string): string | undefined;
}

/**
 * An instant-answer toolchain prepared for one call (binding execution "instant"): the adapter's answer to
 * the arguments, and the toolchain the request goes to when the adapter cannot answer.
 */
export type InstantRun = {
	/** The answer sentence, or a safe code for why the adapter has none. Rejects only when aborted. */
	run(
		args: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<{ ok: true; answer: string } | { ok: false; code: string }>;
	/** The (available) toolchain the binding names for a failed answer; null when it is not available now. */
	fallback: {
		toolchainId: string;
		revisionId: string;
		functionName: string;
	} | null;
};

/** A bound command toolchain's tools as the command sub-agent is offered them. */
export type BoundCommandSet = {
	bindingRevisionId: string;
	adapterRef: string;
	artifactRevisionId: string;
	packageRevisionId: string;
	tools: Array<{
		/** Tool definition id (e.g. `timer.start`) the model names. */
		id: string;
		toolRevisionId: string;
		operationName: string;
		inputSchemaRef: string;
		summary: string;
		/** Flat JSON Schema projected from inputSchemaRef. */
		schema: Record<string, unknown>;
	}>;
	/**
	 * The question schemas this binding allows besides `builtin:answerText`, and which field
	 * the host fills from its own choices.
	 */
	questions: Array<{ inputSchemaRef: string; choiceField?: string }>;
	/**
	 * The binding's `agent.turn`: the execution policy of the single-shot task started after acceptance (spec
	 * playwright-toolchain §5.4). Never applied to the command's own acceptance inference. Absent: no task.
	 */
	agentTurn?: {
		maxModelCalls?: number;
		retries?: Readonly<Record<string, number>>;
	};
};

/**
 * Application-implemented services for bound command toolchains. Dialogue never names a domain:
 * it asks the binding's adapter for its snapshot and validates through registered schemas.
 */
export interface BoundCommandPort {
	/** Host data the command sub-agent may refer to (e.g. current timers). */
	snapshotInTransaction(db: Database, bindingRevisionId: string): unknown;
	/** Validate the model's arguments for one tool of the binding against its schema. */
	parseInvocation(
		set: BoundCommandSet,
		toolId: string,
		args: unknown,
	):
		| {
				ok: true;
				toolRevisionId: string;
				operationName: string;
				input: Record<string, unknown>;
		  }
		| { ok: false; code: string };
	/**
	 * Host-issued choices of a question schema for this binding's adapter (at most 20; empty when
	 * none are available now). Never model text.
	 */
	questionChoicesInTransaction(
		db: Database,
		bindingRevisionId: string,
		inputSchemaRef: string,
	): Array<{ ref: string; label: string }>;
	/** Validate an interaction answer against a registered question schema. */
	parseAnswer(
		inputSchemaRef: string,
		input: unknown,
	): { ok: true; value: unknown } | { ok: false; code: string };
	/**
	 * The frozen package capability the agent runtime executes the operation with (opaque to
	 * dialogue). Throws `capability_unavailable` when the package or adapter is unavailable.
	 */
	prepareInTransaction(
		db: Database,
		runId: string,
		set: BoundCommandSet,
		invocation: { toolRevisionId: string; input: Record<string, unknown> },
	): unknown;
}
