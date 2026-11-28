import type { Database } from "bun:sqlite";
import type { ExchangeStep } from "./tool-exchange";
import type { ToolchainCard } from "../../capabilities";
import type { Receipt } from "../../inference";
import type { ImageAnswerTrace } from "../../conversation";
import type { DeliveryEmotion } from "../../delivery";
import type { ParsedCall } from "./generation-tools";
import { adoptMemoryWindow } from "./memory-window";
import { jstSeconds } from "../../../infrastructure/jst-time";
import type { Run } from "../contracts";
import type {
	ExecutionReference,
	RoutedPipelineStep,
} from "../../tool-runtime";
import type { QueryVector, ToolchainRoute } from "../contracts/toolchains";
import { byId } from "../repository";
import type { DialogueDeps, GenerateInput } from "./context";
import { operationRejection } from "./operation-authority";
import { consumeAnswer } from "./result-intake";

/** Provenance of records read by read tools during a turn, so forgetting any source invalidates carried results. */
export type ReadSources = {
	messageIds?: string[];
	itemIds?: string[];
	sources?: string[];
};

/** What one executed tool call gave the generation. */
export type ToolOutcome = {
	/** The tool's result. */
	result: unknown;
	/** A specialist session took the conversation over: the generation ends here, without speech of its own. */
	end?: true;
	/** A search's cards as it found them, and the vector of its query (what the router scores and corrects by). */
	search?: { cards: ToolchainCard[]; query?: QueryVector };
	/** Sources referenced by a read tool call, merged into the run's provenance manifest. */
	readSources?: ReadSources;
};

/** Executes one call of a fixed tool; throws a `ValidationFailure` for a call the host refuses outright. */
export type ToolExecutor = (
	call: ParsedCall,
	context: {
		signal: AbortSignal;
		receipt?: Receipt;
		routedSteps?: readonly RoutedPipelineStep[];
		/** The searches and hand-overs this generation made before this call. */
		exchange: readonly ExchangeStep[];
	},
) => Promise<ToolOutcome>;

export type GenerationOutcome = {
	/** Publishes visible output, or returns the host's spoken fallback when the write fails. */
	finishSilentReplyInTransaction?: (db: Database) => string;
	debugTarget?: string;
	imageAnswer?: ImageAnswerTrace;
	/** The speech the generation ends with ("" when it said nothing). */
	text: string;
	receipt?: Receipt;
	/** The feeling the agent said it with. */
	emotion?: DeliveryEmotion;
	/** Every executed call and its outcome, in order. */
	executed: Array<{ call: ParsedCall; outcome: ToolOutcome }>;
	/** The searches and hand-overs as the model made them, refused ones too: what later turns see of this one. */
	exchange: ExchangeStep[];
	/** Merged provenance of all read-tool records returned during this turn. */
	readSources?: ReadSources;
	/** A tool call handed the work over and ended the generation. */
	ended: boolean;
};

/** A delegation that ended the generation: the announcement was delivered and a session took the conversation over. */
export type Handover = {
	announcement: string;
};

export type Request = {
	card: ToolchainCard;
	request: string;
	inputs?: Record<string, unknown>;
	diagnosticRef?: string;
	target?: string;
	resolveUnsaved?: "discard";
	routedSteps?: readonly RoutedPipelineStep[];
	/** The resources handed over with the request: the references the toolchain reads, and their URIs. */
	references?: ExecutionReference[];
	refUris?: string[];
};

/** The candidates' descriptions the search returns (section 6.2); the log keeps only their ids and titles. */
export function candidateOf(
	card: ToolchainCard,
	targets: Array<{ ref: string; label: string }> | null,
	/** The display names of the resource kinds the toolchain makes (the registry's labels). */
	produces: readonly string[] = [],
) {
	return {
		id: card.id,
		title: card.title,
		summary: card.summary,
		useWhen: card.useWhen,
		...(card.execution ? { execution: card.execution } : {}),
		...(card.general ? { general: true as const } : {}),
		...(produces.length ? { produces } : {}),
		...(card.instant ? { inputs: card.instant.parameters } : {}),
		...(card.read ? { inputs: card.read.parameters } : {}),
		...(card.taskInputs ? { inputs: card.taskInputs } : {}),
		...(targets ? { targets } : {}),
	};
}

/**
 * What every tool of one generation shares: the run it acts for, the toolchains it may delegate to (the one a switch waits for, then
 * found), the search it made, the handover that ended it, and the checks every action makes first.
 */
export function createExecutorContext(
	deps: DialogueDeps,
	ctx: {
		input: GenerateInput;
		jobId: string;
		publish: () => void;
	},
) {
	const { clock, continuity } = deps;
	const { input, jobId } = ctx;
	const events = continuity.events;
	const offered = new Map<string, ToolchainCard>(
		[
			...(input.switching ? [{ card: input.switching }] : []),
			...(input.offers ?? []),
		].map((entry) => [entry.card.id, entry.card]),
	);
	const state: {
		search: { route: ToolchainRoute; query?: QueryVector; text: string } | null;
		newlyOffered: Set<string>;
		handover: Handover | null;
		/** The instant toolchain that answered in this generation, with the inputs it was given. */
		instant: { card: ToolchainCard; inputs: Record<string, unknown> } | null;
		/** The read tool the search offered and this generation used, with its arguments. */
		read: { card: ToolchainCard; inputs: Record<string, unknown> } | null;
		/** The toolchain this generation handed work to as the agent's assignment, with the request it was given. */
		assigned: { card: ToolchainCard; request: string } | null;
		/** The newest model call's receipt: its permission is checked again before every action. */
		receipt: Receipt | undefined;
		/** The searches and hand-overs made before the call that runs now (the tool-call reliability design, P1). */
		exchange: readonly ExchangeStep[];
	} = {
		search: null,
		newlyOffered: new Set(),
		handover: null,
		instant: null,
		read: null,
		assigned: null,
		receipt: undefined,
		exchange: [],
	};
	/** The user's messages this generation acts on: every action it makes comes from them. */
	const origin = [
		...new Set([
			...(input.final.kind === "utterances" ? input.final.messageIds : []),
			input.inputMessageId,
		]),
	];
	/**
	 * The key of one action (section 8.2): the utterances it handles (or this run, when it handles none) and its
	 * target. A repair or a retried generation calling it again finds the first.
	 */
	const actionKey = (target: string) =>
		input.final.kind === "utterances"
			? `u:${input.final.seqs.join(",")}:${target}`
			: `r:${input.runId}:${input.revision}:${target}`;
	const at = () => jstSeconds(Date.parse(clock()));
	const utteranceText = () => input.utterances.join("\n");
	/** The run must still be this generation's, and every authority the prompt stood on current. */
	function current(tx: Database): Run {
		deps.externalOutput?.assertCurrent(tx, input.runId);
		const run = byId(tx, input.runId);
		if (!run || run.status !== "running" || run.revision !== input.revision)
			throw new Error("run_changed");
		const rejected = operationRejection(tx, {
			inference: deps.larm,
			memory: deps.memory,
			memoryWindow: input.memory,
			...(state.receipt ? { receipt: state.receipt } : {}),
			settle: { runId: run.id },
		});
		if (rejected) throw new Error(rejected);
		return run;
	}

	/**
	 * One action of the agent as an event, keyed by `actionKey(target)`: recorded once. It shows the messages it came
	 * from, so forgetting them clears it.
	 */
	function acted(
		tx: Database,
		target: string,
		fields: Record<string, unknown>,
		shortFields?: Record<string, unknown>,
	) {
		return actedOnce(tx, target, fields, shortFields).event;
	}

	/** `acted`, and whether this call recorded it (false: an earlier call of the same action did). */
	function actedOnce(
		tx: Database,
		target: string,
		fields: Record<string, unknown>,
		shortFields?: Record<string, unknown>,
	) {
		return events.appendInTransaction(tx, {
			conversationId: input.conversationId,
			at: at(),
			type: "acted",
			by: "agent",
			fields,
			...(shortFields ? { shortFields } : {}),
			messageIds: origin,
			dedupeKey: actionKey(target),
		});
	}

	/** A side effect is the generation's first adoption (section 8.2): the utterances it acts on are handled. */
	function handle(tx: Database) {
		if (input.final.kind === "utterances")
			events.handleInTransaction(tx, input.conversationId, input.final.seqs);
	}

	return {
		deps,
		input,
		jobId,
		publish: ctx.publish,
		events,
		offered,
		state,
		at,
		utteranceText,
		current,
		acted,
		actedOnce,
		handle,
		origin,
		actionKey,
	};
}
export type ExecutorContext = ReturnType<typeof createExecutorContext>;

/** A dispatch the toolchain refused: the step rolls back and the model reads the code. */
export class HandoverRefused extends Error {
	constructor(readonly code: string) {
		super(code);
	}
}

/**
 * The adoption a handover stands in for (the generation ends there), before the work is dispatched: the
 * sub-agent's answer it spoke of is consumed and the memory window it read is recorded.
 */
export function adoptHere(x: ExecutorContext, tx: Database, run: Run) {
	const { deps, input } = x;
	if (input.agent && !consumeAnswer(deps, tx, run, input.agent))
		throw new Error("report_invalidated");
	if (input.memory && deps.memory) {
		const adopted = adoptMemoryWindow(deps.memory, tx, run, input.memory);
		if (!adopted.ok) throw new Error(adopted.reason);
	}
}
