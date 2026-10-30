import type { Database } from "bun:sqlite";
import type { ExchangeStep } from "./tool-exchange";
import type { ToolchainCard } from "../../capabilities";
import type { Receipt } from "../../inference";
import { adoptMemoryWindow } from "./memory-window";
import { jstSeconds } from "../../../infrastructure/jst-time";
import type { Run } from "../contracts";
import type { ExecutionReference } from "../../tool-runtime";
import type { QueryVector, ToolchainRoute } from "../contracts/toolchains";
import { byId } from "../repository";
import type { DialogueDeps, GenerateInput } from "./context";
import { operationRejection } from "./operation-authority";
import { consumeAnswer } from "./result-intake";

/** Impacts, least first (the toolchain's declared least impact raises the estimate). */
export const IMPACT_ORDER = [
	"none",
	"create",
	"modify_existing",
	"irreversible",
] as const;

/** A delegation that ended the generation: the announcement was delivered and the work handed over. */
export type Handover = {
	announcement: string;
	/** The run waits for the work (queued behind its job) or a session took the conversation over. */
	handed: boolean;
	workId: string | null;
};

export type Request = {
	card: ToolchainCard;
	request: string;
	inputs?: Record<string, unknown>;
	target?: string;
	resolveUnsaved?: "discard";
	announcement: string;
	confirmationId?: string;
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
		...(card.minImpact ? { minImpact: card.minImpact } : {}),
		...(card.general ? { general: true as const } : {}),
		...(produces.length ? { produces } : {}),
		...(card.instant ? { inputs: card.instant.parameters } : {}),
		...(card.pipeline
			? { inputs: card.pipeline.parameters, steps: card.pipeline.outline }
			: {}),
		...(targets ? { targets } : {}),
	};
}

/**
 * What every tool of one generation shares: the run it acts for, the toolchains it may delegate to (retained, then
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
		input.retained.map((entry) => [entry.card.id, entry.card]),
	);
	const state: {
		search: { route: ToolchainRoute; query?: QueryVector } | null;
		handover: Handover | null;
		/** The instant toolchain that answered in this generation, with the inputs it was given. */
		instant: { card: ToolchainCard; inputs: Record<string, unknown> } | null;
		/** The newest model call's receipt: its permission is checked again before every action. */
		receipt: Receipt | undefined;
		/** Each TODO's revision as the model last saw it (`<state>`, then the work tool's results). */
		todoRevisions: Map<string, number>;
		/** The searches and hand-overs made before the call that runs now (the tool-call reliability design, P1). */
		exchange: readonly ExchangeStep[];
	} = {
		search: null,
		handover: null,
		instant: null,
		receipt: undefined,
		todoRevisions: new Map(Object.entries(input.todoRevisions)),
		exchange: [],
	};
	/** The user's messages this generation acts on: every action, TODO and confirmation it makes comes from them. */
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
		return events.appendInTransaction(tx, {
			conversationId: input.conversationId,
			at: at(),
			type: "acted",
			by: "agent",
			fields,
			...(shortFields ? { shortFields } : {}),
			messageIds: origin,
			dedupeKey: actionKey(target),
		}).event;
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

/**
 * The handover's receipt, accepted only when this was the run's last generation. A run handed to another job (an
 * agent, a command, a media job or a specialist's turn) goes on under the same request, and the receipt of its last
 * call is the one adopted.
 */
export function acceptHere(
	x: ExecutorContext,
	tx: Database,
	dispatched: { handed: boolean },
) {
	const receipt = x.state.receipt;
	if (dispatched.handed) return;
	if (receipt && !x.deps.larm.acceptInTransaction?.(tx, receipt))
		throw new Error("permission_revoked");
}
