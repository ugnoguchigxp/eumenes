import type { CallSession, Receipt } from "../../inference";
import { estimateMessageTokens } from "../../inference";
import type { SpeechPreparation } from "../../delivery";
import { isBriefSpokenReply } from "../../delivery";
import type { NativeToolCall } from "../../../infrastructure/chat-stream";
import { getLogger, withLogContext } from "../../../infrastructure/logger";
import { ValidationFailure } from "../../../infrastructure/validation-log";
import type { ChatMessage, DialogueDeps, GenerateInput } from "./context";
import { conversationOutput } from "./conversation-output";
import {
	TOOL_NAMES,
	generationTools,
	parseCall,
	toolRejection,
	type ParsedCall,
	type RespondArgs,
} from "./generation-tools";

const log = getLogger("dialogue");

/** Tool calls one generation may make in all (section 6.1, initial value). */
export const MAX_TOOL_CALLS = 4;

/** What one executed tool call gave the generation: its result for the model, and what it counts as a basis for. */
export type ToolOutcome = {
	/** The JSON the model reads as the tool's result. */
	result: unknown;
	/**
	 * What the call settled, for the basis check (section 6.3): a delegation committed, a work operation that
	 * succeeded, an instant toolchain's answer, a confirmation issued.
	 */
	basis?: "delegated" | "work" | "instant" | "confirmation" | "history";
	/** The work was handed over (the run now waits for it): the generation ends here, without speech of its own. */
	end?: true;
};

/** Executes one call of a non-respond tool; throws a `ValidationFailure` for a call the host refuses outright. */
export type ToolExecutor = (
	call: Exclude<ParsedCall, { name: "respond" }>,
	context: { signal: AbortSignal; searched: boolean; receipt?: Receipt },
) => Promise<ToolOutcome>;

export type GenerationOutcome = {
	/** The speech the generation ends with ("" when it decided to say nothing). */
	text: string;
	receipt?: Receipt;
	respond?: RespondArgs;
	/** Every executed call and its outcome, in order. */
	executed: Array<{ call: ParsedCall; outcome: ToolOutcome }>;
	/** The one structural repair was used. */
	repaired: boolean;
	/** A tool call handed the work over and ended the generation. */
	ended: boolean;
};

/** The calls of the newest tool-call message that have no result yet are answered as refused. */
function closeRefusedCalls(exchanges: ChatMessage[]) {
	let at = exchanges.length - 1;
	while (at >= 0 && !exchanges[at]!.tool_calls?.length) at--;
	if (at < 0) return;
	const answered = new Set(
		exchanges.slice(at + 1).map((message) => message.tool_call_id),
	);
	for (const call of exchanges[at]!.tool_calls!)
		if (!answered.has(call.id))
			exchanges.push({
				role: "tool",
				tool_call_id: call.id,
				content: JSON.stringify({ refused: true }),
			});
}

/** The analysis values whose answer needs a basis (section 6.3). */
function needsBasis(respond: RespondArgs): "live" | "act" | "past" | null {
	if (respond.freshness === "live" || respond.kind === "live_info")
		return "live";
	if (respond.kind === "action" || respond.kind === "creation") return "act";
	if (respond.kind === "past_conversation") return "past";
	return null;
}

/**
 * The basis check (section 6.3), structural only: an answer to a request that needs one must stand on what this
 * generation settled or what the window shows, never on a search alone or on nothing.
 */
export function basisMissing(
	respond: RespondArgs,
	executed: GenerationOutcome["executed"],
	window: { activeTodos: ReadonlySet<string>; eventIds: ReadonlySet<string> },
): boolean {
	const need = needsBasis(respond);
	if (!need || respond.unavailable) return false;
	const settled = new Set(executed.map((entry) => entry.outcome.basis));
	const fromActive = (respond.todoRefs ?? []).some((id) =>
		window.activeTodos.has(id),
	);
	if (need === "live")
		return !(
			settled.has("instant") ||
			settled.has("delegated") ||
			settled.has("confirmation") ||
			fromActive
		);
	if (need === "act")
		return !(
			settled.has("delegated") ||
			settled.has("confirmation") ||
			settled.has("work")
		);
	return !(
		settled.has("history") ||
		(respond.about ?? []).some(
			(id) => id === "episode" || window.eventIds.has(id),
		)
	);
}

/**
 * One generation (section 6): the model may speak, stay silent, and call the fixed tools; the host runs each call
 * and gives its result back as a tool message, until the model ends with speech (or silence). A user's new
 * utterance makes `respond` mandatory and its basis checked. One structural repair, then failure.
 */
export async function runGeneration(
	deps: DialogueDeps,
	input: GenerateInput,
	options: {
		signal: AbortSignal;
		delta: (text: string) => void;
		preparation?: SpeechPreparation;
		session?: Pick<CallSession, "context" | "refs">;
		repair: () => void;
		execute: ToolExecutor;
		window: { activeTodos: ReadonlySet<string>; eventIds: ReadonlySet<string> };
	},
): Promise<GenerationOutcome> {
	const { signal } = options;
	const executed: GenerationOutcome["executed"] = [];
	const base = [...input.messages];
	/** The tool exchanges of this generation so far, kept across the repair. */
	const exchanges: ChatMessage[] = [];
	let diagnostics: ChatMessage | null = null;
	let repaired = false;
	let searched = false;
	const callSession: CallSession = {
		sessionRole: "main",
		...(options.session?.context ? { context: options.session.context } : {}),
		...(options.session?.refs ? { refs: options.session.refs } : {}),
	};
	const firstNewest = 2;
	const messagesNow = () => [
		...base.slice(0, firstNewest),
		...(diagnostics ? [diagnostics] : []),
		...base.slice(firstNewest),
		...exchanges,
	];
	for (;;) {
		signal.throwIfAborted();
		const messages = messagesNow();
		const output = conversationOutput(options.delta, generationTools);
		log.debug("dialogue.input_measured", {
			phase: "generation",
			kind: "estimated_tokens",
			count: estimateMessageTokens(messages),
			messageCount: messages.length,
			repairAttempt: repaired ? 1 : 0,
		});
		const receipt =
			input.requestId && deps.larm.executeStream
				? await withLogContext({ phase: "generation" }, () =>
						deps.larm.executeStream!(
							input.requestId!,
							messages,
							signal,
							output.delta,
							options.preparation,
							generationTools,
							callSession,
						),
					)
				: undefined;
		const text = receipt
			? (receipt.value as string)
			: await deps.larm.answer(messages, signal);
		signal.throwIfAborted();
		try {
			const parsed = (receipt?.toolCalls ?? []).map(parseCall);
			const respondCalls = parsed.filter(
				(call): call is Extract<ParsedCall, { name: "respond" }> =>
					call.name === TOOL_NAMES.respond,
			);
			const work = parsed.filter(
				(call): call is Exclude<ParsedCall, { name: "respond" }> =>
					call.name !== TOOL_NAMES.respond,
			);
			if (work.length > 0) {
				// Text written beside a tool call is a preamble: withdrawn, never adopted.
				if (text.trim()) options.repair();
				if (executed.length + work.length > MAX_TOOL_CALLS)
					throw toolRejection("tool_call_limit");
				exchanges.push({
					role: "assistant",
					content: "",
					tool_calls: work.map((call) => ({
						id: call.call.id,
						type: "function",
						function: { name: call.call.name, arguments: call.call.arguments },
					})),
				});
				for (const call of work) {
					if (call.name === TOOL_NAMES.search) {
						if (searched) throw toolRejection("search_limit");
					}
					const outcome = await options.execute(call, {
						signal,
						searched,
						...(receipt ? { receipt } : {}),
					});
					if (call.name === TOOL_NAMES.search) searched = true;
					executed.push({ call, outcome });
					exchanges.push({
						role: "tool",
						tool_call_id: call.call.id,
						content: JSON.stringify(outcome.result),
					});
					// The work was handed over: the run waits for it, and this generation says nothing more.
					if (outcome.end) {
						output.finish("");
						return {
							text: "",
							...(receipt ? { receipt } : {}),
							executed,
							repaired,
							ended: true,
						};
					}
				}
				continue;
			}
			const respond = respondCalls[respondCalls.length - 1]?.args;
			output.finish(text);
			// Only a call that could carry tools owes the analysis: a plain completion has no tool to call.
			if (input.final.kind === "utterances" && receipt && !respond)
				throw toolRejection("respond_required");
			if (text.trim() && input.briefReply && !isBriefSpokenReply(text))
				throw toolRejection("spoken_reply_too_long");
			if (
				input.final.kind === "utterances" &&
				respond &&
				basisMissing(respond, executed, options.window)
			)
				throw toolRejection("answer_without_basis");
			return {
				text,
				...(receipt ? { receipt } : {}),
				...(respond ? { respond } : {}),
				executed,
				repaired,
				ended: false,
			};
		} catch (error) {
			if (!(error instanceof ValidationFailure)) throw error;
			// A call refused part-way still gets a result: every tool call of a message is answered before the next one.
			closeRefusedCalls(exchanges);
			for (const issue of error.issues)
				log.warn("dialogue.operation_rejected", {
					...issue,
					repairAttempt: repaired ? 1 : 0,
					issueCount: error.issues.length,
				});
			if (repaired) throw new Error("invalid_conversation_operation");
			repaired = true;
			options.repair();
			// The diagnostics and the rejected output go before the newest message; the tool exchanges already
			// carried out stay, so the model rewrites knowing what is done (section 6.6).
			diagnostics = {
				role: "user",
				content:
					"UNTRUSTED_REJECTED_OUTPUT=" +
					JSON.stringify({
						textPreview: text.slice(0, 4096),
						textTruncated: text.length > 4096,
						toolCalls: (receipt?.toolCalls ?? [])
							.slice(0, 4)
							.map((call: NativeToolCall) => ({
								name: generationTools.some((t) => t.function.name === call.name)
									? call.name
									: null,
								argumentsPreview: call.arguments.slice(0, 4096),
								truncated: call.arguments.length > 4096,
							})),
						issues: error.issues,
						...(error.repair?.length ? { fields: error.repair } : {}),
					}),
			};
		}
	}
}
