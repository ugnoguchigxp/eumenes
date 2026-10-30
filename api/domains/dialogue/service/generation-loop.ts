import type { CallSession, Receipt } from "../../inference";
import { estimateMessageTokens } from "../../inference";
import type { DeliveryEmotion, SpeechPreparation } from "../../delivery";
import type { NativeTool } from "../../../infrastructure/chat-stream";
import { getLogger, withLogContext } from "../../../infrastructure/logger";
import { systemContext } from "../../../infrastructure/system-context";
import { ValidationFailure } from "../../../infrastructure/validation-log";
import type {
	AgentMessage,
	AgentToolCall,
	AgentToolDefinition,
	ConversationAgentPort,
} from "../contracts";
import type { ChatMessage, DialogueDeps, GenerateInput } from "./context";
import { conversationOutput } from "./conversation-output";
import { refusalText, toolResultText } from "./result-text";
import { carriesExchange, type ExchangeStep } from "./tool-exchange";
import {
	generationTools,
	parseCall,
	toolRejection,
	type ParsedCall,
} from "./generation-tools";

const log = getLogger("dialogue");
const TOOL_LIMIT_NOTE = systemContext(
	"dialogue.contexts.generation-loop.tool-limit",
	{},
);

/** Tool calls one generation may make in all (section 6.1, initial value). */
export const MAX_TOOL_CALLS = 4;
/** Refused calls one generation may make besides: a refusal is answered, for the agent to repair its call. */
export const MAX_REFUSED_CALLS = 2;
/** The calls one reply may make, refused ones included; after the last, the reply is made without a call. */
export const REPLY_CALLS = MAX_TOOL_CALLS + MAX_REFUSED_CALLS;

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
		// The agent loop serves the cloud harness only: both sides take its level.
		reasoning: {
			larm: input.harness.call.reasoning,
			cloud: input.harness.call.reasoning,
		},
		...(options.session?.context ? { context: options.session.context } : {}),
		...(options.session?.refs ? { refs: options.session.refs } : {}),
	};

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
			// The calls are used up: the same definitions go (the cached prefix holds) and no call can be made.
			const noCall = offered.length === 0 && agentTools.length > 0;
			const output = conversationOutput(
				onDelta,
				generationTools,
				input.harness.gates.systemCopy && base[0]?.role === "system"
					? base[0].content
					: undefined,
				input.toolchainTitles,
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
			const stream = deps.larm.executeStream;
			let answered: Receipt;
			try {
				answered = await withLogContext({ phase: "generation" }, () =>
					stream.call(
						deps.larm,
						requestId,
						messages,
						signal,
						output.delta,
						options.preparation,
						noCall ? generationTools : offered,
						noCall ? { ...callSession, toolChoice: "none" } : callSession,
					),
				);
			} catch (error) {
				// A call that ended cleanly with nothing to say: the reply says nothing, as the system allows.
				if (
					!signal.aborted &&
					error instanceof Error &&
					error.message === "chat_output_empty"
				)
					return { text: output.finish(""), toolCalls: [] };
				throw error;
			}
			signal.throwIfAborted();
			receipt = answered;
			// The answer is what was published: control syntax written as text is not part of it.
			return {
				text: output.finish(answered.value as string),
				toolCalls: (answered.toolCalls ?? []).map((call) => ({
					id: call.id,
					name: call.name,
					arguments: call.arguments,
				})),
			};
		},
	};

	const refused = (error: ValidationFailure) => {
		for (const issue of error.issues)
			log.warn("dialogue.operation_rejected", {
				...issue,
				issueCount: error.issues.length,
			});
		return {
			// The log's sanitized issues are not for the model: a call it wrote wrong gets the fields to repair.
			content: error.repair?.length
				? refusalText(error.message, error.repair)
				: toolResultText("refused", { refused: true, issues: error.issues }),
		};
	};

	let calls = 0;
	const tools: Parameters<ConversationAgentPort["respond"]>[0]["tools"] = {
		tools: agentTools,
		async call(call: AgentToolCall, signal: AbortSignal) {
			const answer = await callTool(call, signal);
			// The reply's last call: the agent is told it answers with what it has.
			return ++calls === REPLY_CALLS
				? { ...answer, content: `${answer.content}\n${TOOL_LIMIT_NOTE}` }
				: answer;
		},
	};
	async function callTool(
		call: AgentToolCall,
		signal: AbortSignal,
	): Promise<{ content: string; end?: boolean }> {
		try {
			const parsed = parseCall(call);
			if (executed.length >= MAX_TOOL_CALLS)
				throw toolRejection("tool_call_limit");
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
	}

	const reply = await deps.conversationAgent.respond({
		messages: base as AgentMessage[],
		chat,
		tools,
		signal: options.signal,
		onDelta: options.delta,
		maxToolCalls: REPLY_CALLS,
	});
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
