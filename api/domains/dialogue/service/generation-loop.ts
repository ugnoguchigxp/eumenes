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
import { conversationOutput } from "./conversation-output";
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
	/** The JSON the agent reads as the tool's result. */
	result: unknown;
	/** A confirmation was issued (section 6.7): the reply is its question. */
	confirmation?: true;
	/** The work was handed over (the run now waits for it): the generation ends here, without speech of its own. */
	end?: true;
};

/** Executes one call of a fixed tool; throws a `ValidationFailure` for a call the host refuses outright. */
export type ToolExecutor = (
	call: ParsedCall,
	context: { signal: AbortSignal; searched: boolean; receipt?: Receipt },
) => Promise<ToolOutcome>;

export type GenerationOutcome = {
	/** The speech the generation ends with ("" when it said nothing). */
	text: string;
	receipt?: Receipt;
	/** The feeling the agent said it with. */
	emotion?: DeliveryEmotion;
	/** Every executed call and its outcome, in order. */
	executed: Array<{ call: ParsedCall; outcome: ToolOutcome }>;
	/** A tool call handed the work over and ended the generation. */
	ended: boolean;
};

/** The output bound of one model call, in tokens. */
const GENERATION_OUTPUT_LIMIT = 1024;

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
	const base = input.messages;
	let receipt: Receipt | undefined;
	let searched = false;
	const callSession: CallSession = {
		sessionRole: "main",
		speaks: true,
		// A short spoken reply and the tool arguments fit far below this; a runaway output stops here.
		outputLimit: GENERATION_OUTPUT_LIMIT,
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
			const output = conversationOutput(onDelta, generationTools);
			log.debug("dialogue.input_measured", {
				phase: "generation",
				kind: "estimated_tokens",
				count: estimateMessageTokens(messages),
				messageCount: messages.length,
			});
			if (!input.requestId || !deps.larm.executeStream) {
				const text = await deps.larm.answer(messages, signal);
				output.delta(text);
				output.finish(text);
				return { text, toolCalls: [] };
			}
			receipt = await withLogContext({ phase: "generation" }, () =>
				deps.larm.executeStream!(
					input.requestId!,
					messages,
					signal,
					output.delta,
					options.preparation,
					offered,
					callSession,
				),
			);
			signal.throwIfAborted();
			const text = receipt.value as string;
			output.finish(text);
			return {
				text,
				toolCalls: (receipt.toolCalls ?? []).map((call) => ({
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
			content: JSON.stringify({
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
				if (parsed.name === TOOL_NAMES.search && searched)
					throw toolRejection("search_limit");
				const outcome = await options.execute(parsed, {
					signal,
					searched,
					...(receipt ? { receipt } : {}),
				});
				if (parsed.name === TOOL_NAMES.search) searched = true;
				executed.push({ call: parsed, outcome });
				return {
					content: JSON.stringify(outcome.result),
					...(outcome.end ? { end: true } : {}),
				};
			} catch (error) {
				if (error instanceof ValidationFailure) return refused(error);
				throw error;
			}
		},
	};

	const reply = await deps.conversationAgent.respond({
		messages: base as AgentMessage[],
		chat,
		tools,
		signal: options.signal,
		onDelta: options.delta,
	});
	options.signal.throwIfAborted();
	// The work was handed over: the run waits for it, and this generation says nothing more.
	if (reply.ended)
		return {
			text: "",
			...(receipt ? { receipt } : {}),
			executed,
			ended: true,
		};
	return {
		text: reply.text,
		...(receipt ? { receipt } : {}),
		...(reply.emotion ? { emotion: reply.emotion } : {}),
		executed,
		ended: false,
	};
}
