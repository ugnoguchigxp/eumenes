import type { CallSession, Receipt } from "../../inference";
import { estimateMessageTokens } from "../../inference";
import type { DeliveryEmotion, SpeechPreparation } from "../../delivery";
import type { NativeTool } from "../../../infrastructure/chat-stream";
import { getLogger, withLogContext } from "../../../infrastructure/logger";
import { ValidationFailure } from "../../../infrastructure/validation-log";
import type {
	AgentMessage,
	AgentToolCall,
	AgentToolDefinition,
	ConversationAgentPort,
} from "../contracts";
import type { ChatMessage, DialogueDeps, GenerateInput } from "./context";
import { conversationOutput, systemCopyCheck } from "./conversation-output";
import { cloudHarness, localHarness } from "./harness";
import { openIntentGate } from "./intent-gate";
import {
	decisionMessages,
	decisionSchema,
	runLocalTurn,
	type TurnResult,
} from "./local-turn";
import { toolResultText } from "./result-text";
import { carriesExchange, type ExchangeStep } from "./tool-exchange";
import {
	TOOL_NAMES,
	generationTools,
	parseCall,
	toolRejection,
	type ParsedCall,
} from "./generation-tools";

const log = getLogger("dialogue");

/** Tool calls one generation may make in all (section 6.1, initial value). */
export const MAX_TOOL_CALLS = 4;

/** What one executed tool call gave the generation. */
export type ToolOutcome = {
	/** The tool's result; the agent reads it as text (`toolResultText`). */
	result: unknown;
	/** A confirmation was issued (section 6.7): the reply is its question. */
	confirmation?: true;
	/** The work was handed over (the run now waits for it): the generation ends here, without speech of its own. */
	end?: true;
};

/** Executes one call of a fixed tool; throws a `ValidationFailure` for a call the host refuses outright. */
export type ToolExecutor = (
	call: ParsedCall,
	context: {
		signal: AbortSignal;
		receipt?: Receipt;
		/** The searches and hand-overs this generation made before this call. */
		exchange: readonly ExchangeStep[];
	},
) => Promise<ToolOutcome>;

export type GenerationOutcome = {
	/** The speech the generation ends with ("" when it said nothing). */
	text: string;
	receipt?: Receipt;
	/** The feeling the agent said it with. */
	emotion?: DeliveryEmotion;
	/** Every executed call and its outcome, in order. */
	executed: Array<{ call: ParsedCall; outcome: ToolOutcome }>;
	/** The searches and hand-overs as the model made them, refused ones too: what later turns see of this one. */
	exchange: ExchangeStep[];
	/** A tool call handed the work over and ended the generation. */
	ended: boolean;
};

const agentTools: AgentToolDefinition[] = generationTools.map((tool) => ({
	name: tool.function.name,
	description: tool.function.description,
	parameters: tool.function.parameters,
}));
const nativeTools = new Map(
	generationTools.map((tool) => [tool.function.name, tool]),
);

/**
 * One generation: the conversation agent answers, and uses the fixed tools in its reply when the conversation calls
 * for them. The host makes each model call (with the prepared messages, which lead every call) and runs each tool
 * call; a refused call is answered with its reason, for the agent to go on with.
 */
export async function runGeneration(
	deps: DialogueDeps,
	input: GenerateInput,
	options: {
		signal: AbortSignal;
		delta: (text: string) => void;
		preparation?: SpeechPreparation;
		session?: Pick<CallSession, "context" | "refs">;
		execute: ToolExecutor;
	},
): Promise<GenerationOutcome> {
	const executed: GenerationOutcome["executed"] = [];
	const exchange: ExchangeStep[] = [];
	const carry = (call: AgentToolCall, result: unknown) => {
		if (carriesExchange(call.name))
			exchange.push({ name: call.name, arguments: call.arguments, result });
	};
	const base = input.messages;
	let receipt: Receipt | undefined;
	const callSession: CallSession = {
		sessionRole: "main",
		// The harness's bound stops a runaway output; the reasoning counts in it.
		outputLimit: input.harness.call.outputLimit,
		// Each side answers with its own harness's reasoning: a call that falls back from LARM to the cloud moves to
		// the cloud harness's (the input stays the one this run built).
		reasoning: {
			larm: localHarness.call.reasoning,
			cloud: cloudHarness.call.reasoning,
		},
		...(options.session?.context ? { context: options.session.context } : {}),
		...(options.session?.refs ? { refs: options.session.refs } : {}),
	};
	// The user-intent judge runs before the first model call (the intent gate design, section 5).
	const gate = await openIntentGate(deps, input, options.signal);
	const searched = () =>
		executed.some(({ call }) => call.name === TOOL_NAMES.search);
	// Only the turn's first call is made to call a tool; later ones keep the search-first refusal alone.
	let forced = false;

	const chat: Parameters<ConversationAgentPort["respond"]>[0]["chat"] = {
		async complete(request, onDelta, signal) {
			// The prepared messages (images included) lead; the agent adds only its tool exchanges.
			const messages: ChatMessage[] = [
				...base,
				...(request.messages.slice(base.length) as ChatMessage[]),
			];
			const offered = request.tools.flatMap((tool): NativeTool[] => {
				const native = nativeTools.get(tool.name);
				return native ? [native] : [];
			});
			const output = conversationOutput(
				onDelta,
				generationTools,
				input.harness.gates.systemCopy && base[0]?.role === "system"
					? base[0].content
					: undefined,
			);
			log.debug("dialogue.input_measured", {
				phase: "generation",
				kind: "estimated_tokens",
				count: estimateMessageTokens(messages),
				messageCount: messages.length,
			});
			if (!input.requestId || !deps.larm.executeStream) {
				const text = await deps.larm.answer(messages, signal);
				output.delta(text);
				return { text: output.finish(text), toolCalls: [] };
			}
			const requestId = input.requestId;
			// The decision call has no delta function at all: nothing flows, so the run is not marked as having published.
			const stream = deps.larm.executeStream;
			const call = (
				onDelta: ((text: string) => void) | undefined,
				callSignal: AbortSignal,
				offering: NativeTool[] | undefined,
				session: CallSession,
				preparation: SpeechPreparation | undefined,
				sent: ChatMessage[] = messages,
			) =>
				withLogContext({ phase: "generation" }, () =>
					stream.call(
						deps.larm,
						requestId,
						sent,
						callSignal,
						onDelta,
						preparation,
						offering,
						session,
					),
				);
			/** One call that replies or calls a tool, published as it streams. */
			const single = async (session: CallSession): Promise<TurnResult> => {
				const answered = await call(
					output.delta,
					signal,
					offered,
					session,
					options.preparation,
				);
				signal.throwIfAborted();
				// The answer is what was published: control syntax written as text is not part of it.
				return {
					text: output.finish(answered.value as string),
					toolCalls: (answered.toolCalls ?? []).map((call) => ({
						id: call.id,
						name: call.name,
						arguments: call.arguments,
					})),
					receipt: answered,
				};
			};
			// A search the judge asked for: the turn's first call must call a tool, and the search is the one taken.
			const forceSearch =
				input.harness.turn === "single" &&
				gate.route === "search" &&
				!forced &&
				offered.some((t) => t.function.name === TOOL_NAMES.search);
			if (forceSearch) forced = true;
			const taken =
				input.harness.turn === "decide-then-reply"
					? await runLocalTurn(
							{
								decide: () =>
									call(
										undefined,
										signal,
										undefined,
										{ ...callSession, outputSchema: decisionSchema(offered) },
										// A silent call: no speech is collected from it.
										undefined,
										// A schema call carries no tool definitions: the functions are listed in its input.
										decisionMessages(messages, offered),
									),
								// A failed head stops the call from its delta; the request stays usable for the cloud call.
								reply: (onDelta) =>
									call(
										onDelta,
										signal,
										offered,
										{
											...callSession,
											// With no tool offered (the call limit is reached) there is nothing to hold back.
											...(offered.length
												? { toolChoice: "none" as const }
												: {}),
											retainRequest: true,
										},
										options.preparation,
									),
								cloud: () => single({ ...callSession, target: "cloud" }),
							},
							{
								base,
								own: messages.slice(base.length),
								offered: offered.map((tool) => tool.function.name),
								output,
								...(input.harness.gates.systemCopy && base[0]?.role === "system"
									? { copies: systemCopyCheck(base[0].content) }
									: {}),
								signal,
							},
						)
					: await single(
							forceSearch
								? { ...callSession, toolChoice: "required" }
								: callSession,
						);
			receipt = taken.receipt;
			return { text: taken.text, toolCalls: taken.toolCalls };
		},
	};

	const refused = (error: ValidationFailure) => {
		for (const issue of error.issues)
			log.warn("dialogue.operation_rejected", {
				...issue,
				issueCount: error.issues.length,
			});
		return {
			content: toolResultText("refused", {
				refused: true,
				issues: error.issues,
				...(error.repair?.length ? { fields: error.repair } : {}),
			}),
		};
	};

	const tools: Parameters<ConversationAgentPort["respond"]>[0]["tools"] = {
		tools: agentTools,
		async call(call: AgentToolCall, signal: AbortSignal) {
			try {
				const parsed = parseCall(call);
				if (executed.length >= MAX_TOOL_CALLS)
					throw toolRejection("tool_call_limit");
				if (
					gate.route === "search" &&
					parsed.name !== TOOL_NAMES.search &&
					!searched()
				)
					throw toolRejection("search_first");
				const outcome = await options.execute(parsed, {
					signal,
					...(receipt ? { receipt } : {}),
					exchange,
				});
				executed.push({ call: parsed, outcome });
				carry(call, outcome.result);
				return {
					content: toolResultText(parsed.name, outcome.result),
					...(outcome.end ? { end: true } : {}),
				};
			} catch (error) {
				if (error instanceof ValidationFailure) {
					carry(call, { refused: true });
					return refused(error);
				}
				throw error;
			}
		},
	};

	const reply = await deps.conversationAgent
		.respond({
			messages: base as AgentMessage[],
			chat,
			tools,
			signal: options.signal,
			onDelta: options.delta,
		})
		.finally(() =>
			gate.observe({
				searched: searched(),
				delegated: executed.some(
					({ call }) => call.name === TOOL_NAMES.delegate,
				),
			}),
		);
	// The work was handed over (committed by its tool): the run waits for it, and this generation says nothing more.
	// A later commit (the work failing at once) must not discard the hand-over, so no abort check comes first.
	if (reply.ended)
		return {
			text: "",
			...(receipt ? { receipt } : {}),
			executed,
			exchange,
			ended: true,
		};
	options.signal.throwIfAborted();
	return {
		text: reply.text,
		...(receipt ? { receipt } : {}),
		...(reply.emotion ? { emotion: reply.emotion } : {}),
		executed,
		exchange,
		ended: false,
	};
}
