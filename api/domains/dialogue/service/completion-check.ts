import { z } from "zod";
import { systemContext } from "../../../infrastructure/system-context";
import type { NativeTool } from "../../../infrastructure/chat-stream";
import { parseLlmJson } from "../../../infrastructure/llm-json";
import { getLogger } from "../../../infrastructure/logger";
import type { Database } from "bun:sqlite";
import type { ConversationService } from "../../conversation";
import type { Receipt } from "../../inference";
import type { Run } from "../contracts";
import {
	byId,
	chainAttempts,
	continuationOf,
	type PriorStep,
} from "../repository";
import type { ContextBlock } from "../../inference";
import type { ChatMessage, CompletionCheck, DialogueDeps } from "./context";

const log = getLogger("dialogue");

/** Steps after the first a request may take; the last step's check only reports what stays unmet. */
export const MAX_CONTINUATIONS = 3;
/**
 * The check is a short structured call. A forced tool call on a long context can run on without end; its bound
 * keeps a runaway from spending the answer's time (the check then stays unverified).
 */
export const CHECK_OUTPUT_TOKENS = 1536;

const condition = z.string().trim().min(1).max(300);
const step = z.number().int().min(1).nullable();
const checkInput = <T extends z.ZodType>(item: T) =>
	z.strictObject({
		conditions: z.array(item).min(1).max(12),
		achieved: z.string().trim().max(1000),
		need: z.string().trim().max(500),
	});
/**
 * The first check also says how each condition is met: by an operation of a toolchain, or by the answer itself
 * (telling, summing up, reporting). Only the operation conditions make the chain; the answer meets the others.
 */
const firstInput = checkInput(
	z.strictObject({ condition, kind: z.enum(["operation", "answer"]), step }),
);
/** Later checks decide only the steps of the fixed (operation) conditions. */
const laterInput = checkInput(z.strictObject({ condition, step }));
export type CompletionDecision =
	| { status: "done" }
	/** The check gave no valid decision: the answer claims only what the results show. */
	| { status: "unverified" }
	/** The request is not achieved and goes no further: the answer says which conditions are still unmet. */
	| { status: "unmet"; unmet: string[] }
	| {
			status: "continue";
			achieved: string;
			/** The next step's purpose: the first condition no step satisfies yet. */
			need: string;
			/** The request's conditions, fixed by the first check for the rest of the chain. */
			conditions: string[];
			unmet: string[];
			receipt?: Receipt;
	  };

/**
 * One function: every condition of the request, each with the step whose result satisfies it or null. Once the
 * first check fixed the conditions, later checks name exactly those and decide only the steps.
 */
function tools(steps: number, fixed?: string[]): NativeTool[] {
	const parameters = z.toJSONSchema(
		fixed ? laterInput : firstInput,
	) as unknown as {
		properties: {
			conditions: {
				minItems?: number;
				maxItems?: number;
				items: {
					properties: {
						condition: Record<string, unknown>;
						step: { anyOf: Array<Record<string, unknown>> };
					};
				};
			};
		};
	};
	const list = parameters.properties.conditions;
	// Only a step that was taken can be named: the schema says so, and the parse checks it again.
	for (const option of list.items.properties.step.anyOf)
		if (option.type === "integer") option.maximum = steps;
	if (fixed) {
		list.items.properties.condition.enum = fixed;
		list.minItems = list.maxItems = fixed.length;
	}
	return [
		{
			type: "function",
			function: {
				name: "check_request",
				description: systemContext(
					"dialogue.contexts.completion-check.check",
					{},
				),
				parameters: parameters as unknown as Record<string, unknown>,
			},
		},
	];
}

/**
 * The host decides from the structure, and names the next purpose itself: the first unmet condition no step was
 * taken for yet (none: the request goes no further). The first check lists the conditions and keeps those an
 * operation meets (a purpose it names with every one satisfied is one more, unmet condition); later checks may
 * neither add, drop nor rename them, so a result can introduce no new purpose.
 */
function parseDecision(
	calls: Array<{ name: string; arguments: string }> | undefined,
	check: CompletionCheck,
	steps: number,
):
	| { status: "done" }
	| (Omit<Extract<CompletionDecision, { status: "continue" }>, "need"> & {
			need?: string;
	  }) {
	if (calls?.length !== 1) throw new Error("completion_call_count");
	const call = calls[0]!;
	if (call.name !== "check_request")
		throw new Error("completion_tool_not_offered");
	const args = parseLlmJson(call.arguments);
	const value = check.conditions
		? laterInput.parse(args)
		: (() => {
				const first = firstInput.parse(args);
				return {
					...first,
					conditions: first.conditions
						.filter((c) => c.kind === "operation")
						.map(({ condition, step }) => ({ condition, step })),
				};
			})();
	if (value.conditions.some((c) => c.step !== null && c.step > steps))
		throw new Error("completion_step_unknown");
	// A step whose results all failed achieved nothing: it is the evidence of no condition.
	if (
		value.conditions.some((c) => c.step !== null && failedStep(check, c.step))
	)
		throw new Error("completion_step_failed");
	let listed = value.conditions;
	if (check.conditions) {
		const named = new Set(listed.map((c) => c.condition));
		if (
			listed.length !== check.conditions.length ||
			check.conditions.some((c) => !named.has(c))
		)
			throw new Error("completion_conditions_changed");
		listed = check.conditions.map((condition) =>
			listed.find((c) => c.condition === condition)!,
		);
	} else if (value.need && listed.every((c) => c.step !== null))
		listed = [...listed, { condition: value.need, step: null }];
	const unmet = listed.filter((c) => c.step === null).map((c) => c.condition);
	if (!unmet.length) return { status: "done" };
	// Each condition is tried once: a step taken for it that the check still finds unmet is not taken again.
	const tried = new Set(check.attempts.map((a) => a.condition));
	return {
		status: "continue",
		achieved: value.achieved,
		need: unmet.find((c) => !tried.has(c)),
		conditions: listed.map((c) => c.condition),
		unmet,
	};
}

/**
 * A step failed when every result it returned is a failure record of the host (a failed or cancelled operation, an
 * error code, a research that failed). Read from the stored results, never from a model's wording.
 */
function failedStep(check: CompletionCheck, step: number) {
	const results = check.steps.find((s) => s.step === step)?.results ?? [];
	return results.length > 0 && results.every((r) => failure(r.value));
}
function failure(value: unknown): boolean {
	if (!value || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	return (
		v.action === "failed" ||
		v.state === "failed" ||
		v.state === "cancelled" ||
		(typeof v.errorCode === "string" && v.errorCode.length > 0) ||
		(!!v.report &&
			typeof v.report === "object" &&
			"failure" in (v.report as object))
	);
}

/**
 * The conversation's check of one delegated step against the user's own request text: which step satisfies each
 * condition. One structural correction; an output that stays invalid, or a call that fails, continues nothing and
 * the step's result is answered as usual.
 */
export async function judgeCompletion(
	deps: Pick<DialogueDeps, "larm">,
	input: { requestId?: string; completionCheck: CompletionCheck },
	messages: ChatMessage[],
	signal: AbortSignal,
): Promise<CompletionDecision> {
	const check = input.completionCheck;
	if (!input.requestId || !deps.larm.executeStream) return { status: "done" };
	const steps = check.hop + 1;
	const offered = tools(steps, check.conditions);
	// The condition this step was taken for; the first step served none.
	const served = check.attempts.find((a) => a.step === steps)?.condition;
	const checkMessages = (
		correction?: string,
		reconsider?: string,
	): ChatMessage[] => [
		{
			role: "system",
			content:
				systemContext("dialogue.contexts.completion-check.instruction", {}) +
				"\nCOMPLETION_CHECK=" +
				JSON.stringify({
					originalRequest: check.originalRequest,
					earlierSteps: check.achieved || null,
					stepCount: steps,
					...(check.conditions ? { conditions: check.conditions } : {}),
				}),
		},
		...(correction
			? [
					{
						role: "system" as const,
						content:
							systemContext(
								"dialogue.contexts.completion-check.correction",
								{},
							) + ` (${correction})`,
					},
				]
			: []),
		...(reconsider
			? [
					{
						role: "system" as const,
						content:
							systemContext(
								"dialogue.contexts.completion-check.reconsider",
								{},
							) +
							"\nRECONSIDER=" +
							JSON.stringify({ condition: reconsider, step: steps }),
					},
				]
			: []),
	];
	let attempt = beforeCurrentRequest(messages, checkMessages());
	for (let i = 0; i < 2; i++) {
		signal.throwIfAborted();
		let receipt: Receipt;
		try {
			receipt = await deps.larm.executeStream(
				input.requestId,
				attempt,
				signal,
				() => {},
				undefined,
				offered,
				// Its only valid output is the check: the provider is told to call it rather than answer in text.
				{
					sessionRole: "auxiliary",
					toolChoice: "required",
					outputLimit: CHECK_OUTPUT_TOKENS,
				},
			);
		} catch {
			signal.throwIfAborted();
			// The step's own result is already settled: a failed check must not fail its answer, nor stand for one.
			log.warn("dialogue.completion_check_failed", {});
			return { status: "unverified" };
		}
		try {
			const decision = parseDecision(receipt.toolCalls, check, steps);
			if (decision.status !== "continue") return decision;
			const failed = failedStep(check, steps);
			// This step was taken for a condition, did not fail, and is still found short of it: one second look.
			if (i === 0 && served && !failed && decision.unmet.includes(served)) {
				log.info("dialogue.completion_check_reconsidered", {});
				attempt = beforeCurrentRequest(
					messages,
					checkMessages(undefined, served),
				);
				continue;
			}
			// The chain's last step, a step that failed, or no condition left untried goes no further: the answer
			// says what is still unmet instead of claiming it.
			if (!decision.need || check.hop >= MAX_CONTINUATIONS || failed)
				return { status: "unmet", unmet: decision.unmet };
			return { ...decision, need: decision.need, receipt };
		} catch (error) {
			const code =
				error instanceof Error && error.message.startsWith("completion_")
					? error.message
					: "completion_arguments_invalid";
			log.warn("dialogue.completion_check_rejected", {
				reason: code,
				repairAttempt: i,
			});
			attempt = beforeCurrentRequest(messages, checkMessages(code));
		}
	}
	return { status: "unverified" };
}

/** The hidden input of the next step: the frame and the request's data, never an instruction of the user's. */
export function continuationText(
	check: CompletionCheck,
	achieved: string,
	need: string,
) {
	return (
		systemContext("dialogue.contexts.completion-check.continuation", {}) +
		"\nCONTINUATION=" +
		JSON.stringify({
			originalRequest: check.originalRequest,
			achieved,
			next: need,
		})
	);
}

/**
 * This step's results, as the conversation received them, for the steps after it. An image travels as the fact
 * that it was made and its reference, not its content.
 */
export function stepResultsInTransaction(
	deps: Pick<DialogueDeps, "image">,
	tx: Database,
	runId: string,
	blocks: ContextBlock[],
): PriorStep["results"] {
	return blocks.flatMap((block) =>
		block.body.kind !== "json"
			? []
			: [
					{
						source: block.source,
						value:
							block.source === "operation.image"
								? (deps.image?.referenceInTransaction?.(tx, runId) ??
									block.body.value)
								: block.source === "research.result"
									? // The time the report was phrased at is this step's; a later step has its own.
										{ report: (block.body.value as { report: unknown }).report }
									: block.body.value,
					},
				],
	);
}

/**
 * A continuation's earlier steps, whole, as one reference message just before the request's input: placed after the
 * window was fitted, so no step is clipped. The indices at or after it move by one.
 */
export function withPriorSteps<
	R extends {
		messages: ChatMessage[];
		currentRequestIndex: number;
		blockIndex: Partial<Record<string, number>>;
	},
>(rendered: R, steps: PriorStep[]): R {
	if (!steps.length) return rendered;
	const at = rendered.currentRequestIndex;
	const messages = [...rendered.messages];
	// Results, like the operation results and reports: data in a user message, never a system instruction.
	messages.splice(at, 0, {
		role: "user",
		content:
			systemContext("dialogue.contexts.completion-check.prior-steps", {}) +
			"\nPRIOR_STEPS=" +
			JSON.stringify(steps),
	});
	const shift = (i: number) => (i >= at ? i + 1 : i);
	return {
		...rendered,
		messages,
		currentRequestIndex: at + 1,
		blockIndex: Object.fromEntries(
			Object.entries(rendered.blockIndex).map(([k, i]) => [
				k,
				i === undefined ? i : shift(i),
			]),
		),
	};
}

/** Host state for an answer whose request stays unmet: the conditions it must not claim. */
export function unmetMessage(unmet: string[]): ChatMessage {
	return {
		role: "system",
		content:
			systemContext("dialogue.contexts.completion-check.unmet", {}) +
			"\nUNMET_CONDITIONS=" +
			JSON.stringify(unmet),
	};
}

/** Host state for an answer whose request could not be checked: it claims nothing the results do not show. */
export function unverifiedMessage(): ChatMessage {
	return {
		role: "system",
		content: systemContext("dialogue.contexts.completion-check.unverified", {}),
	};
}

/** The answer of a step after which the request goes on: the host's fixed line; the next step announces itself. */
export function progressLine() {
	return systemContext("dialogue.contexts.completion-check.progress", {});
}

/**
 * Host state travels before the CURRENT_REQUEST marker that anchors the user's input, which stays the last
 * message of every call (see `markCurrentRequest`).
 */
export function beforeCurrentRequest(
	messages: ChatMessage[],
	added: ChatMessage[],
): ChatMessage[] {
	const marker = messages.at(-2);
	const at =
		marker?.role === "system" && marker.content.startsWith("CURRENT_REQUEST=")
			? messages.length - 2
			: messages.length - 1;
	return [...messages.slice(0, at), ...added, ...messages.slice(at)];
}

/**
 * A continuation no longer stands for its request: the user wrote again after the request (a new human run), or
 * the request's own input was withdrawn. It is not run.
 */
export function chainSuperseded(
	conversation: ConversationService,
	tx: Database,
	rootRunId: string,
) {
	const root = byId(tx, rootRunId);
	if (
		!root ||
		conversation.sourceInTransaction(tx, root.inputMessageId).state !==
			"available"
	)
		return true;
	return !!tx
		.query(
			"SELECT 1 FROM dialogue_runs WHERE conversation_id=? AND source_kind IN ('manual','voice') AND seq > (SELECT seq FROM dialogue_runs WHERE id=?) LIMIT 1",
		)
		.get(root.conversationId, root.id);
}

/**
 * Whether this generation phrases a delegated step's result for a user's request, and what its check reads.
 * Not checked: a new decision, a question back, a notice, a specialist session, a system prompt, or a run that
 * resumed a toolchain's question. The chain's last step is checked only to say what stays unmet. A continuation's
 * new decision searches the purpose it names instead.
 */
export function completionCheckInTransaction(
	deps: Pick<DialogueDeps, "conversation" | "image">,
	tx: Database,
	run: Run,
	phase: {
		routing?: object;
		/** The delegated step's results this answer phrases; none for anything else. */
		results: ContextBlock[];
		hostAside: boolean;
		/** A finished pipeline's notice: the run whose request the pipeline was started for. */
		origin?: string;
	},
): CompletionCheck | undefined {
	const continuation =
		run.sourceKind === "continuation" ? continuationOf(tx, run.id) : null;
	if (phase.routing && continuation)
		Object.assign(phase.routing, { continuation: { need: continuation.need } });
	const hop = continuation?.hop ?? 0;
	const checked =
		!phase.routing &&
		phase.results.length > 0 &&
		!phase.hostAside &&
		!run.specialistSessionId &&
		hop <= MAX_CONTINUATIONS &&
		(run.sourceKind === "manual" ||
			run.sourceKind === "voice" ||
			!!continuation ||
			(run.sourceKind === "notice" && !!phase.origin)) &&
		!resumedQuestion(tx, run.id);
	const origin = phase.origin ? byId(tx, phase.origin) : null;
	const originalRequest =
		continuation?.originalRequest ??
		deps.conversation.messageInTransaction(
			tx,
			origin?.inputMessageId ?? run.inputMessageId,
		)?.message.text;
	return checked && originalRequest
		? {
				originalRequest,
				rootRunId: continuation?.rootRunId ?? origin?.id ?? run.id,
				hop,
				achieved: continuation?.achieved ?? "",
				...(continuation ? { conditions: continuation.conditions } : {}),
				steps: [
					...(continuation?.steps ?? []),
					{
						step: hop + 1,
						results: stepResultsInTransaction(deps, tx, run.id, phase.results),
					},
				],
				attempts: continuation
					? chainAttempts(tx, continuation.rootRunId, hop)
					: [],
			}
		: undefined;
}

/**
 * A continuation run whose request was superseded or withdrawn before it delegated (no announcement yet): it ends
 * without acting. A step already delegated is still answered.
 */
export function continuationEnded(
	conversation: ConversationService,
	tx: Database,
	run: Run,
) {
	if (run.sourceKind !== "continuation" || run.announcement) return false;
	const continuation = continuationOf(tx, run.id);
	return (
		!continuation || chainSuperseded(conversation, tx, continuation.rootRunId)
	);
}

/** A run that resumed a toolchain's question has the user's answer as its input, not the request. */
function resumedQuestion(tx: Database, runId: string) {
	return (
		!!tx
			.query("SELECT 1 FROM sqlite_master WHERE name='command_interactions'")
			.get() &&
		!!tx
			.query(
				"SELECT 1 FROM command_interactions WHERE current_run_id=? LIMIT 1",
			)
			.get(runId)
	);
}
