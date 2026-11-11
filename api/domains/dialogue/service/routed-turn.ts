import type { CallSession, Receipt } from "../../inference";
import type { SpeechPreparation } from "../../delivery";
import type { RoutedPipelineStep } from "../../tool-runtime";
import { getLogger, withLogContext } from "../../../infrastructure/logger";
import { systemContext } from "../../../infrastructure/system-context";
import { ValidationFailure } from "../../../infrastructure/validation-log";
import { z } from "zod";
import type { NativeTool } from "../../../infrastructure/chat-stream";
import type {
	AgentMessage,
	AgentToolCall,
	AgentToolDefinition,
} from "../contracts";
import type { ChatMessage, DialogueDeps, GenerateInput } from "./context";
import { conversationOutput } from "./conversation-output";
import { imageAnswerTrace } from "./attachment-context";
import { availableReadTools, readToolDefinitions } from "./executor-read";
import type {
	GenerationOutcome,
	ToolExecutor,
	ToolOutcome,
} from "./executor-context";
import { memoryArgs, parseCall, TOOL_NAMES } from "./generation-tools";
import { INPUT_HEADINGS } from "./input-text";
import { refusalText, toolResultText } from "./result-text";
import { parseChoice, strictChoiceSchema } from "./routed-choice";
import type { Step } from "./routed-actions";
import { activeRouter } from "./routed-package";
import { routerTurn } from "./routed-router";
import { carriesExchange, type ExchangeStep } from "./tool-exchange";

const log = getLogger("dialogue");
/** The host's words for a turn whose call failed before anything was said. */
const SAID_FAILED = systemContext("dialogue.contexts.local.turn-failed", {});
const MEMORY_REQUEST_TOOL: AgentToolDefinition = {
	name: TOOL_NAMES.memory,
	description: systemContext("dialogue.contexts.local.memory-request", {}),
	parameters: z.toJSONSchema(memoryArgs.options[0]!),
};

export type RoutedTurnOptions = {
	signal: AbortSignal;
	delta: (text: string) => void;
	preparation?: SpeechPreparation;
	session?: Pick<CallSession, "context" | "refs">;
	execute: ToolExecutor;
	/** Closes the confirmation `c<ref>` the user declined, with the run's authority checks; false when not open. */
	decline?: (ref: number, receipt?: Receipt) => Promise<boolean>;
};

/**
 * Failures of the turn's own model calls (the output, not the run's authority): when nothing reached the user yet,
 * the host says its fixed words instead of failing silently (the local harness rebuild plan, section 4.5). A talk
 * that said nothing to the user who spoke is one of them.
 */
const CALL_FAILURES = new Set([
	"local_timeout",
	"network_unavailable",
	"inference_failed",
	"chat_output_empty",
	"chat_stream_incomplete",
	"chat_stream_too_large",
	"llm_stream_stalled",
	"chat_output_too_large",
	"chat_frame_too_large",
	"chat_stream_error",
	"system_text_copied",
	// A talk call with the read tools: a call without its arguments, or a call made when none was offered.
	"chat_tool_calls_invalid",
	"chat_tool_calls_unexpected",
]);
/**
 * A model call that failed on its own (the stream's, the provider's or the connection's fault), not the run's: the
 * turn still answers (a choice that failed leaves it to the talk turn; a talk that failed gets the host's words).
 */
const callFailed = (code: string) =>
	CALL_FAILURES.has(code) ||
	/^(cloud_http|cloud_agent|larm_inference|larm_control)_[a-z0-9_]+$/.test(
		code,
	);

/** Convert only a completed talk reply; structured choices and tool preambles attest no image answer. */
function completedTalk(
	answered: Receipt,
	messages: ChatMessage[],
	output: ReturnType<typeof conversationOutput>,
) {
	const text = output.finish(String(answered.value ?? ""));
	return {
		text,
		imageAnswer:
			text.trim() && !answered.toolCalls?.length
				? imageAnswerTrace(answered, messages)
				: undefined,
		toolCalls: (answered.toolCalls ?? []).map(
			({ id, name, arguments: args }) => ({ id, name, arguments: args }),
		),
	};
}

/**
 * One turn of the local harness (the local harness rebuild plan, section 4): the eumenes_router package decides every
 * utterance turn, the conversation among the toolchains, the work and the open confirmations and questions (spec
 * router-package-integration 2026-11-04 §1 #12), with no model call of its own; the model talks (one call, no tools)
 * when the turn is the conversation's, when no router is saved, or when it could not decide. Every word for the user
 * goes out through one mouth, so what was said is the answer.
 */
export async function runRoutedTurn(
	deps: DialogueDeps,
	input: GenerateInput,
	options: RoutedTurnOptions,
): Promise<GenerationOutcome> {
	const turn = createTurn(deps, input, options);
	const { routed } = turn;
	let kind: "talk" | "request" | "pending" = "talk";
	try {
		let step: Step = "talk";
		// A hand-over may need the fill call on the run's request; without it the turn only talks.
		if (
			input.final.kind === "utterances" &&
			routed &&
			turn.canChoose &&
			turn.router
		) {
			const pending =
				routed.pending.confirmations.length > 0 ||
				routed.pending.questions.length > 0 ||
				routed.switching !== null;
			kind = pending ? "pending" : "request";
			step = await routerTurn(turn, turn.router);
		}
		if (step === "talk") await turn.talk();
	} catch (error) {
		const code = error instanceof Error ? error.message : "";
		if (options.signal.aborted || turn.published() || !callFailed(code))
			throw error;
		log.warn("dialogue.turn_failed", { kind, reason: code });
		turn.answer(SAID_FAILED);
	}
	log.info("dialogue.turn_routed", { kind, count: turn.calls() });
	options.signal.throwIfAborted();
	const { receipt, emotion, imageAnswer } = turn.result();
	return {
		text: turn.said().trim(),
		...(receipt ? { receipt } : {}),
		...(emotion ? { emotion } : {}),
		...(imageAnswer ? { imageAnswer } : {}),
		executed: turn.executed,
		exchange: turn.exchange,
		ended: turn.executed.some(({ outcome }) => outcome.end === true),
	};
}

/** What the steps of one routed turn share: its words, its model calls and its host operations. */
export type Turn = ReturnType<typeof createTurn>;

function callSession(
	input: GenerateInput,
	options: RoutedTurnOptions,
): CallSession {
	return {
		sessionRole: "main",
		agentSession: {
			conversationId: input.conversationId,
			agentId: input.conversationId,
		},
		// The turn settles its request itself (a model answer, or the host's words): a failed call ends only that call,
		// so a choice can be made again, the talk turn follow it, or the host answer.
		retainRequest: true,
		outputLimit: input.harness.call.outputLimit,
		reasoning: {
			larm: input.harness.call.reasoning,
			cloud: input.harness.call.cloudReasoning,
		},
		...(options.session?.context ? { context: options.session.context } : {}),
		...(options.session?.refs ? { refs: options.session.refs } : {}),
	};
}

function createTurn(
	deps: DialogueDeps,
	input: GenerateInput,
	options: RoutedTurnOptions,
) {
	const { signal } = options;
	const executed: GenerationOutcome["executed"] = [];
	const exchange: ExchangeStep[] = [];
	let receipt: Receipt | undefined;
	let imageAnswer: GenerationOutcome["imageAnswer"];
	let said = "";
	let emotion: GenerationOutcome["emotion"];
	let calls = 0;
	let seq = 0;
	let published = false;
	/** Every word for the user goes out here: the run is marked as having said something once a word went. */
	const delta = (text: string) => {
		if (signal.aborted) return;
		if (text) published = true;
		options.delta(text);
	};
	const session = callSession(input, options);

	/** One model call on the run's request: a streamed reply (`onDelta`) or a silent choice (`outputSchema`). */
	const call = (
		messages: ChatMessage[] | AgentMessage[],
		onDelta: ((text: string) => void) | undefined,
		extra: Pick<CallSession, "outputSchema" | "cloudOutputSchema">,
		tools?: NativeTool[],
	) => {
		signal.throwIfAborted();
		const stream = deps.larm.executeStream;
		if (!input.requestId || !stream) throw new Error("routed_turn_unavailable");
		calls++;
		return withLogContext({ phase: "generation" }, () =>
			stream.call(
				deps.larm,
				input.requestId!,
				messages as ChatMessage[],
				signal,
				onDelta,
				onDelta ? options.preparation : undefined,
				tools,
				{ ...session, ...extra },
			),
		);
	};

	/** One host operation through the generation's executor, kept as an executed call of the turn. */
	async function operate(
		name: string,
		args: Record<string, unknown>,
		routedSteps?: readonly RoutedPipelineStep[],
	): Promise<{ outcome: ToolOutcome } | { refused: ValidationFailure }> {
		signal.throwIfAborted();
		const raw = {
			id: `routed-${++seq}`,
			name,
			arguments: JSON.stringify(args),
		};
		try {
			const parsed = parseCall(raw);
			const outcome = await options.execute(parsed, {
				signal,
				...(receipt ? { receipt } : {}),
				...(routedSteps ? { routedSteps } : {}),
				exchange,
			});
			executed.push({ call: parsed, outcome });
			if (carriesExchange(name))
				exchange.push({
					name,
					arguments: raw.arguments,
					result: outcome.result,
				});
			return { outcome };
		} catch (error) {
			if (!(error instanceof ValidationFailure)) throw error;
			for (const issue of error.issues)
				log.warn("dialogue.operation_rejected", {
					...issue,
					issueCount: error.issues.length,
				});
			if (carriesExchange(name))
				exchange.push({
					name,
					arguments: raw.arguments,
					result: { refused: true },
				});
			return { refused: error };
		}
	}

	return {
		deps,
		input,
		signal,
		routed: input.routed,
		canChoose: !!(input.requestId && deps.larm.executeStream),
		/** The saved router, when it is on and the ports it needs are there (spec router-package-integration 2026-11-04). */
		router: activeRouter(deps),
		utterance: input.utterances.join("\n"),
		executed,
		exchange,
		calls: () => calls,
		said: () => said,
		published: () => published,
		result: () => ({ receipt, emotion, imageAnswer }),

		/** The host's own words: spoken as they are, and part of the answer. */
		speak(text: string) {
			signal.throwIfAborted();
			const words = text.trim();
			if (!words) return;
			const piece = said ? `\n${words}` : words;
			said += piece;
			delta(piece);
		},

		/**
		 * The host's words that end a turn whose calls failed before a word: the answer, not streamed, so it is spoken
		 * once the run's answer is accepted (speech while the run is running stands on a model call of it).
		 */
		answer(text: string) {
			imageAnswer = undefined;
			said = text.trim();
		},

		/**
		 * A silent choice held to `schema`: the object it returned, null when it is no choice (also a call that ended
		 * with nothing in it), or `cut` when its output ran past the limit (the request turn passes to talk).
		 */
		async choose(
			messages: ChatMessage[],
			schema: Record<string, unknown>,
		): Promise<ReturnType<typeof parseChoice> | "cut"> {
			let answered: Receipt;
			try {
				answered = await call(messages, undefined, {
					outputSchema: schema,
					cloudOutputSchema: strictChoiceSchema(schema),
				});
			} catch (error) {
				if (signal.aborted || !(error instanceof Error)) throw error;
				if (error.message === "chat_stream_incomplete") return "cut";
				// The choice is the host's aid: a call that failed on its own leaves the turn to the talk turn.
				if (callFailed(error.message)) {
					if (error.message !== "chat_output_empty")
						log.warn("dialogue.choice_failed", { reason: error.message });
					return null;
				}
				throw error;
			}
			signal.throwIfAborted();
			receipt = answered;
			return parseChoice(answered.value);
		},

		/** Closes the confirmation `c<ref>` the user declined (false when it was not open, or no port closes it). */
		decline(ref: number) {
			return options.decline?.(ref, receipt) ?? Promise.resolve(false);
		},

		/** One host operation through the generation's executor: its outcome, or the refusal of its arguments. */
		act: operate,

		/** Why the host refused an operation, as the retry reads it. */
		reasonOf(error: ValidationFailure) {
			return error.repair?.length
				? refusalText(error.message, error.repair)
				: toolResultText("refused", { refused: true, issues: error.issues });
		},

		/**
		 * The talk turn: one streamed call; `notice` adds what the host found for it to tell. On the user's words it may
		 * call one read tool, and a second call answers with what was read (spec conversation-read-tools-design
		 * 2026-10-31 §2); `tools: false` when the host has read for it already.
		 */
		async talk(notice?: string, { tools = true }: { tools?: boolean } = {}) {
			signal.throwIfAborted();
			let talkImageAnswer: GenerationOutcome["imageAnswer"];
			const messages = notice
				? withNotice(input.messages, notice)
				: input.messages;
			const system =
				input.harness.gates.systemCopy && messages[0]?.role === "system"
					? messages[0].content
					: undefined;
			// Tool calls come back on the streamed call only; a port without it answers in one piece.
			const reads =
				tools &&
				input.final.kind === "utterances" &&
				input.requestId &&
				deps.larm.executeStream
					? deps.store.read((db) => availableReadTools(deps, db))
					: [];
			log.info("dialogue.read_tools_offered", {
				count: reads.length,
				kind: reads.join(","),
			});
			const act = this.act;
			// What this talk spoke, and whether it read: a call that fails after a read gets the host's words after it.
			let spoken = "";
			let toolMade = false;
			const offeredTools = [
				...readToolDefinitions(reads),
				...(reads.includes("read_memory") && deps.steward
					? [MEMORY_REQUEST_TOOL]
					: []),
			];
			let reply: Awaited<
				ReturnType<DialogueDeps["conversationAgent"]["respond"]>
			>;
			try {
				reply = await deps.conversationAgent.respond({
					// Every reply of a run is the agency's to serve (notices and work reports too), not only the user's words.
					run: {
						conversationId: input.conversationId,
						runId: input.runId,
						messageIds:
							input.final.kind === "utterances" ? input.final.messageIds : [],
					},
					messages: messages as AgentMessage[],
					chat: {
						async complete(request, onDelta, chatSignal) {
							const output = conversationOutput(onDelta, system);
							// A port without the streamed call answers in one piece, as the agent loop's does.
							if (!input.requestId || !deps.larm.executeStream) {
								// The messages of this call (steered words and the agency's state are in them), not the prompt's.
								const text = await deps.larm.answer(
									request.messages as ChatMessage[],
									chatSignal,
								);
								output.delta(text);
								return { text: output.finish(text), toolCalls: [] };
							}
							try {
								const answered = await call(
									request.messages as AgentMessage[],
									output.delta,
									{},
									request.tools.map((tool) => ({
										type: "function" as const,
										function: tool,
									})),
								);
								chatSignal.throwIfAborted();
								receipt = answered;
								const { imageAnswer: trace, ...reply } = completedTalk(
									answered,
									request.messages as ChatMessage[],
									output,
								);
								talkImageAnswer = trace;
								return reply;
							} catch (error) {
								// A call that ended cleanly with nothing to say: the reply says nothing, as the system allows. So
								// does the answer after a read that calls a tool again, when none is offered any more.
								if (
									!chatSignal.aborted &&
									error instanceof Error &&
									(error.message === "chat_output_empty" ||
										(error.message === "chat_tool_calls_unexpected" &&
											!request.tools.length))
								)
									return { text: output.finish(""), toolCalls: [] };
								throw error;
							}
						},
					},
					tools: conversationToolPort(offeredTools, act, () => {
						toolMade = true;
					}),
					signal,
					onDelta: (text) => {
						spoken += text;
						delta(text);
					},
					maxToolCalls: offeredTools.length ? 1 : 0,
				});
			} catch (error) {
				const code = error instanceof Error ? error.message : "";
				if (signal.aborted || !toolMade || !callFailed(code)) throw error;
				log.warn("dialogue.turn_failed", { kind: "talk", reason: code });
				said = [said, spoken.trim()].filter(Boolean).join("\n");
				this.speak(SAID_FAILED);
				return;
			}
			// The user spoke and was told nothing: a failed reply, not silence (a notice may go unanswered).
			if (
				!reply.text.trim() &&
				!said.trim() &&
				input.final.kind === "utterances"
			)
				throw new Error("chat_output_empty");
			emotion = reply.emotion;
			// The agency's own tools: the exchange keeps them with the reply (later replies see what it did).
			for (const call of reply.calls ?? [])
				exchange.push({
					name: call.name,
					arguments: call.arguments,
					result: call.content,
				});
			imageAnswer = talkImageAnswer;
			said = [said, reply.text].filter(Boolean).join("\n");
		},
	};
}

/**
 * The talk turn's read tools (spec conversation-read-tools-design 2026-10-31): only those offered run, through the
 * turn's executor; any other name, or arguments that are no object, is refused and never run.
 */
function conversationToolPort(
	tools: readonly AgentToolDefinition[],
	act: Turn["act"],
	onRead: () => void,
) {
	return {
		tools,
		async call(toolCall: AgentToolCall) {
			let args: unknown;
			try {
				args = JSON.parse(toolCall.arguments || "{}");
			} catch {
				args = undefined;
			}
			if (
				!tools.some((tool) => tool.name === toolCall.name) ||
				!args ||
				typeof args !== "object" ||
				Array.isArray(args)
			)
				return {
					content: toolResultText("refused", {
						refused: true,
						code: "invalid_tool_call",
					}),
				};
			onRead();
			const read = await act(toolCall.name, args as Record<string, unknown>);
			if ("refused" in read)
				return {
					content: refusalText(read.refused.message, read.refused.repair ?? []),
				};
			const result = read.outcome.result;
			return {
				content:
					typeof result === "object" &&
					result !== null &&
					"text" in result &&
					typeof result.text === "string"
						? result.text
						: (JSON.stringify(result) ?? ""),
			};
		},
	};
}

/** The prepared input with what the host found added to its last message, as a notice to tell. */
function withNotice(messages: ChatMessage[], notice: string): ChatMessage[] {
	const copy = messages.map((message) => ({ ...message }));
	const last = copy.at(-1)!;
	last.content = `${last.content}\n\n${INPUT_HEADINGS.notice}\n${notice}`;
	return copy;
}
