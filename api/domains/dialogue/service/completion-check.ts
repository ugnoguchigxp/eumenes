import { z } from "zod";
import { systemContext } from "../../../infrastructure/system-context";
import type { NativeTool } from "../../../infrastructure/chat-stream";
import { parseLlmJson } from "../../../infrastructure/llm-json";
import { getLogger } from "../../../infrastructure/logger";
import type { Database } from "bun:sqlite";
import type { ConversationService } from "../../conversation";
import type { Receipt } from "../../inference";
import type { Run } from "../contracts";
import { byId, continuationOf } from "../repository";
import type { ChatMessage, CompletionCheck, DialogueDeps } from "./context";

const log = getLogger("dialogue");

/** Steps after the first a request may take; the last step is not checked again. */
export const MAX_CONTINUATIONS = 3;

const checkInput = z.strictObject({
	conditions: z
		.array(
			z.strictObject({
				condition: z.string().trim().min(1).max(300),
				step: z.number().int().min(1).nullable(),
			}),
		)
		.min(1)
		.max(12),
	achieved: z.string().trim().max(1000),
	need: z.string().trim().max(500),
});
export type CompletionDecision =
	| { status: "done" }
	| {
			status: "continue";
			achieved: string;
			/** The next step's purpose: the first condition no step satisfies yet. */
			need: string;
			/** The request's conditions, fixed by the first check for the rest of the chain. */
			conditions: string[];
			receipt?: Receipt;
	  };

/**
 * One function: every condition of the request, each with the step whose result satisfies it or null. Once the
 * first check fixed the conditions, later checks name exactly those and decide only the steps.
 */
function tools(steps: number, fixed?: string[]): NativeTool[] {
	const parameters = z.toJSONSchema(checkInput) as unknown as {
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
 * The host decides from the structure, and names the next purpose itself: the first condition no step satisfies
 * yet. The first check lists the conditions (a purpose it names with every listed condition satisfied is one more,
 * unmet condition); later checks may neither add, drop nor rename them, so a result can introduce no new purpose.
 */
function parseDecision(
	calls: Array<{ name: string; arguments: string }> | undefined,
	check: CompletionCheck,
	steps: number,
): CompletionDecision {
	if (calls?.length !== 1) throw new Error("completion_call_count");
	const call = calls[0]!;
	if (call.name !== "check_request")
		throw new Error("completion_tool_not_offered");
	const value = checkInput.parse(parseLlmJson(call.arguments));
	if (value.conditions.some((c) => c.step !== null && c.step > steps))
		throw new Error("completion_step_unknown");
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
	const unmet = listed.find((c) => c.step === null);
	if (!unmet) return { status: "done" };
	return {
		status: "continue",
		achieved: value.achieved,
		need: unmet.condition,
		conditions: listed.map((c) => c.condition),
	};
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
	const checkMessages = (correction?: string): ChatMessage[] => [
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
				{ sessionRole: "auxiliary" },
			);
		} catch {
			signal.throwIfAborted();
			// The step's own result is already settled: a failed check must not fail its answer.
			log.warn("dialogue.completion_check_failed", {});
			return { status: "done" };
		}
		try {
			const decision = parseDecision(receipt.toolCalls, check, steps);
			return decision.status === "continue"
				? { ...decision, receipt }
				: decision;
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
	return { status: "done" };
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
 * Not checked: a new decision, a question back, a notice, a specialist session, a system prompt, a run that
 * resumed a toolchain's question, or the chain's last step. A continuation's new decision searches the purpose it names instead.
 */
export function completionCheckInTransaction(
	conversation: ConversationService,
	tx: Database,
	run: Run,
	phase: {
		routing?: object;
		delegatedResult: boolean;
		hostAside: boolean;
	},
): CompletionCheck | undefined {
	const continuation =
		run.sourceKind === "continuation" ? continuationOf(tx, run.id) : null;
	if (phase.routing && continuation)
		Object.assign(phase.routing, { continuation: { need: continuation.need } });
	const hop = continuation?.hop ?? 0;
	const checked =
		!phase.routing &&
		phase.delegatedResult &&
		!phase.hostAside &&
		!run.specialistSessionId &&
		hop < MAX_CONTINUATIONS &&
		(run.sourceKind === "manual" ||
			run.sourceKind === "voice" ||
			!!continuation) &&
		!resumedQuestion(tx, run.id);
	const originalRequest =
		continuation?.originalRequest ??
		conversation.messageInTransaction(tx, run.inputMessageId)?.message.text;
	return checked && originalRequest
		? {
				originalRequest,
				rootRunId: continuation?.rootRunId ?? run.id,
				hop,
				achieved: continuation?.achieved ?? "",
				...(continuation ? { conditions: continuation.conditions } : {}),
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
