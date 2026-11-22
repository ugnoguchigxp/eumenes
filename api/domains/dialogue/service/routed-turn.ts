import type { Database } from "bun:sqlite";
import type { CallSession, Receipt } from "../../inference";
import type { SpeechPreparation } from "../../delivery";
import type { RoutedPipelineStep } from "../../tool-runtime";
import { getLogger, withLogContext } from "../../../infrastructure/logger";
import { systemContext } from "../../../infrastructure/system-context";
import { ValidationFailure } from "../../../infrastructure/validation-log";
import { emotionEmojis } from "eumenes-agency";
import { z } from "zod";
import type { NativeTool } from "../../../infrastructure/chat-stream";
import type {
	AgentMessage,
	AgentToolCall,
	AgentToolDefinition,
} from "../contracts";
import type { ChatMessage, DialogueDeps, GenerateInput } from "./context";
import {
	firstConfirmationReply,
	releasePendingReply,
} from "./confirmation-decision";
import { conversationOutput } from "./conversation-output";
import { imageAnswerTrace } from "./attachment-context";
import { availableReadTools, readToolDefinitions } from "./executor-read";
import type {
	GenerationOutcome,
	ReadSources,
	ToolExecutor,
	ToolOutcome,
} from "./executor-context";
import { memoryArgs, parseCall, TOOL_NAMES } from "./generation-tools";
import { refusalText, toolResultText } from "./result-text";
import { parseChoice, strictChoiceSchema } from "./routed-choice";
import { createTalkWork } from "./routed-talk-work";
import { carriesExchange, type ExchangeStep } from "./tool-exchange";

const log = getLogger("dialogue");
/** The host's words for a turn whose call failed before anything was said. */
const SAID_FAILED = systemContext("dialogue.contexts.local.turn-failed", {});
const { $schema: _, ...memoryParameters } = z.toJSONSchema(
	memoryArgs.options[0]!,
);
const MEMORY_REQUEST_TOOL: AgentToolDefinition = {
	name: TOOL_NAMES.memory,
	description: systemContext("dialogue.contexts.local.memory-request", {}),
	parameters: memoryParameters,
};

export type RoutedTurnOptions = {
	signal: AbortSignal;
	delta: (text: string) => void;
	preparation?: SpeechPreparation;
	session?: Pick<CallSession, "context" | "refs">;
	execute: ToolExecutor;
	/** Closes the confirmation `c<ref>` the user declined, with the run's authority checks; false when not open. */
	decline?: (
		ref: number,
		receipt?: Receipt,
		revise?: boolean,
	) => Promise<boolean>;
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

function collectReadSources(
	executed: ReadonlyArray<{ outcome: ToolOutcome }>,
): ReadSources | undefined {
	const messageIds = new Set<string>();
	const itemIds = new Set<string>();
	const sources = new Set<string>();
	for (const { outcome } of executed) {
		for (const id of outcome.readSources?.messageIds ?? []) messageIds.add(id);
		for (const id of outcome.readSources?.itemIds ?? []) itemIds.add(id);
		for (const ref of outcome.readSources?.sources ?? []) sources.add(ref);
	}
	if (!messageIds.size && !itemIds.size && !sources.size) return undefined;
	return {
		...(messageIds.size ? { messageIds: [...messageIds] } : {}),
		...(itemIds.size ? { itemIds: [...itemIds] } : {}),
		...(sources.size ? { sources: [...sources] } : {}),
	};
}

function parseJsonOrText(raw: string): unknown {
	try {
		return JSON.parse(raw);
	} catch {
		return raw;
	}
}

/** Let the conversation agent understand the turn and act through its offered tools. */
export async function runConversationTurn(
	deps: DialogueDeps,
	input: GenerateInput,
	options: RoutedTurnOptions,
): Promise<GenerationOutcome> {
	const debug: Pick<GenerationOutcome, "debugTarget"> = {};
	const turn = createTurn(deps, input, options, debug);
	try {
		await turn.talk();
	} catch (error) {
		const code = error instanceof Error ? error.message : "";
		if (options.signal.aborted || turn.published() || !callFailed(code))
			throw error;
		log.warn("dialogue.turn_failed", { kind: "talk", reason: code });
		turn.answer(SAID_FAILED);
	}
	log.info("dialogue.turn_routed", { kind: "talk", count: turn.calls() });
	options.signal.throwIfAborted();
	const { receipt, emotion, imageAnswer, writeOutput } = turn.result();
	const readSources = collectReadSources(turn.executed);
	return {
		text: turn.said().trim(),
		...(writeOutput
			? {
					finishSilentReplyInTransaction(db: Database) {
						if (writeOutput(db)) return "";
						log.warn("dialogue.turn_failed", {
							runId: input.runId,
							kind: "talk",
							reason: "chat_output_empty",
						});
						return SAID_FAILED;
					},
				}
			: {}),
		...debug,
		...(turn.lookupSources.length ? { lookupSources: turn.lookupSources } : {}),
		...(receipt ? { receipt } : {}),
		...(emotion ? { emotion } : {}),
		...(imageAnswer ? { imageAnswer } : {}),
		...(readSources ? { readSources } : {}),
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
		...(options.session?.refs ? { refs: options.session.refs } : {}),
	};
}

function turnModelCall(
	deps: DialogueDeps,
	input: GenerateInput,
	options: RoutedTurnOptions,
	onCall: () => void,
) {
	const { signal } = options;
	const session = callSession(input, options);
	/**
	 * What only the reply call has: where its messages split (a choice call has messages of its own), and that its
	 * feeling is read from its leading emoji when the agent asks for one: the marks are the emojis `runRespond` reads
	 * (the delivery judge is not run for a reply that starts with one).
	 */
	const replySession = () => ({
		...(options.session?.context ? { context: options.session.context } : {}),
		...(deps.conversationAgent.system().emotionRules
			? { emotionMarks: emotionEmojis }
			: {}),
	});

	/** One model call on the run's request: a streamed reply (`onDelta`) or a silent choice (`outputSchema`). */
	return (
		messages: ChatMessage[] | AgentMessage[],
		onDelta: ((text: string) => void) | undefined,
		extra: Pick<CallSession, "outputSchema" | "cloudOutputSchema">,
		tools?: NativeTool[],
	) => {
		signal.throwIfAborted();
		const stream = deps.larm.executeStream;
		if (!input.requestId || !stream) throw new Error("routed_turn_unavailable");
		onCall();
		return withLogContext({ phase: "generation" }, () =>
			stream.call(
				deps.larm,
				input.requestId!,
				messages as ChatMessage[],
				signal,
				onDelta,
				onDelta ? options.preparation : undefined,
				tools,
				{
					...session,
					...(onDelta ? replySession() : {}),
					...extra,
					...(onDelta && input.observeInput
						? { observeInput: input.observeInput }
						: {}),
				},
			),
		);
	};
}

function createTurn(
	deps: DialogueDeps,
	input: GenerateInput,
	options: RoutedTurnOptions,
	debug: Pick<GenerationOutcome, "debugTarget">,
) {
	const { signal } = options;
	const executed: GenerationOutcome["executed"] = [];
	const exchange: ExchangeStep[] = [];
	const lookupSources: NonNullable<GenerationOutcome["lookupSources"]> = [];
	let receipt: Receipt | undefined;
	let imageAnswer: GenerationOutcome["imageAnswer"];
	let writeOutput: ((db: Database) => boolean) | undefined;
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
	const call = turnModelCall(deps, input, options, () => {
		calls++;
	});

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
		utterance: input.utterances.join("\n"),
		executed,
		exchange,
		lookupSources,
		calls: () => calls,
		said: () => said,
		published: () => published,
		result: () => ({ receipt, emotion, imageAnswer, writeOutput }),

		/** The host's own words: spoken as they are, and part of the answer. */
		speak(text: string) {
			signal.throwIfAborted();
			const words = text.trim();
			if (!words) return;
			// After words of a reply still being written (its tool speaks for the host), on a line of their own too.
			const piece = said || published ? `\n${words}` : words;
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
		decline(ref: number, revise = false) {
			return options.decline?.(ref, receipt, revise) ?? Promise.resolve(false);
		},

		/** One host operation through the generation's executor: its outcome, or the refusal of its arguments. */
		act: operate,

		/** Why the host refused an operation, as the retry reads it. */
		reasonOf(error: ValidationFailure) {
			return error.repair?.length
				? refusalText(error.message, error.repair)
				: toolResultText("refused", { refused: true, issues: error.issues });
		},

		async talk(): Promise<void> {
			signal.throwIfAborted();
			let talkImageAnswer: GenerationOutcome["imageAnswer"];
			const { messages } = input;
			const system =
				input.harness.gates.systemCopy && messages[0]?.role === "system"
					? messages[0].content
					: undefined;
			// Tool calls come back on the streamed call only; a port without it answers in one piece.
			const acts = !!(
				input.final.kind === "utterances" &&
				input.requestId &&
				deps.larm.executeStream
			);
			// What this talk spoke, and whether it read: a call that fails after a read gets the host's words after it.
			let spoken = "";
			let toolMade = false;
			const firstPending = firstConfirmationReply(input.routed);
			const release = releasePendingReply.bind(null, this);
			const saidBefore = said;
			const toolPort = conversationToolPort(
				this,
				acts,
				() => {
					toolMade = true;
				},
				(target) => (debug.debugTarget = target),
			);
			let reply: Awaited<
				ReturnType<DialogueDeps["conversationAgent"]["respond"]>
			>;
			try {
				reply = await deps.conversationAgent.respond({
					...(input.observeInput ? { traceInput: true } : {}),
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
							const check = firstPending(request.tools);
							const output = conversationOutput(
								check ? () => {} : onDelta,
								system,
							);
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
								if (check) {
									const operation = await release(
										request.messages as ChatMessage[],
										reply,
										onDelta,
									);
									if (operation) return { text: "", toolCalls: [operation] };
									receipt = answered;
								}
								talkImageAnswer = trace;
								return reply;
							} catch (error) {
								// A call that ended cleanly with nothing to say: the reply says nothing, as the system allows. So
								// does the answer after a read that calls a tool again, when none is offered any more.
								if (
									!chatSignal.aborted &&
									error instanceof Error &&
									(error.message === "chat_output_empty" ||
										error.message === "cloud_agent_empty_output" ||
										(error.message === "chat_tool_calls_unexpected" &&
											!request.tools.length))
								)
									return { text: output.finish(""), toolCalls: [] };
								throw error;
							}
						},
					},
					tools: toolPort,
					signal,
					onDelta: (text) => {
						spoken += text;
						delta(text);
					},
					maxToolCalls: toolPort.maxToolCalls,
				});
			} catch (error) {
				const code = error instanceof Error ? error.message : "";
				if (signal.aborted || !toolMade || !callFailed(code)) throw error;
				log.warn("dialogue.turn_failed", { kind: "talk", reason: code });
				said = [said, spoken.trim()].filter(Boolean).join("\n");
				this.speak(SAID_FAILED);
				return;
			}
			// A user turn needs a reply, a handover announcement, or visible output that can be published at adoption.
			if (
				!reply.ended &&
				!reply.text.trim() &&
				!said.trim() &&
				input.final.kind === "utterances"
			) {
				writeOutput = await reply.prepareSilentOutput?.();
				if (!writeOutput) throw new Error("chat_output_empty");
			}
			if (debug.debugTarget) return;
			emotion = reply.emotion;
			// The agency's own tools: the exchange keeps them with the reply (later replies see what it did).
			for (const call of reply.calls ?? [])
				exchange.push({
					name: call.name,
					arguments: call.arguments,
					result: call.content,
				});
			imageAnswer = talkImageAnswer;
			// The host's words said inside a tool (a confirmation, a question back) came after what the reply had said.
			const hosted = said.slice(saidBefore.length).trim();
			said = [saidBefore.trim(), reply.text, hosted].filter(Boolean).join("\n");
		},
	};
}

/**
 * The reply's read and work tools. Only offered tools run and their arguments must be objects. Work tools
 * require the routed input and an agent whose reply may hand work over.
 */
const LOOKUP_TOOL = "lookup_public_information";

function conversationToolPort(
	turn: Turn,
	acts: boolean,
	onCall: () => void,
	onDebugTarget: (target: string) => void,
) {
	const { deps, input } = turn;
	const reads = acts
		? deps.store.read((db) => availableReadTools(deps, db))
		: [];
	const work =
		acts &&
		input.routed &&
		deps.toolchains &&
		deps.work &&
		deps.conversationAgent.handsWork?.()
			? createTalkWork(turn)
			: null;
	log.info("dialogue.read_tools_offered", {
		count: reads.length,
		kind: reads.join(","),
		...(work ? { source: "work" } : {}),
	});
	const debug =
		acts && deps.debugDiagnostics?.enabled()
			? deps.debugDiagnostics
			: undefined;
	const readTools = [
		...readToolDefinitions(reads).map((tool) =>
			debug && tool.name === "read_runs"
				? {
						...tool,
						description:
							tool.description +
							" Eumenes自身の失敗や依頼との食い違いを診断するときは target.kind=run を指定します。",
						parameters: withDebugTarget(tool.parameters),
					}
				: tool,
		),
		...(acts && input.routed && deps.steward ? [MEMORY_REQUEST_TOOL] : []),
	];
	const lookup = acts ? deps.lookup : undefined;
	const tools = [...readTools, ...(work?.tools ?? [])];
	if (lookup)
		tools.push({
			name: LOOKUP_TOOL,
			description: systemContext(
				"dialogue.contexts.agency.external-lookup",
				{},
			),
			parameters: {
				type: "object",
				additionalProperties: false,
				required: ["query"],
				properties: { query: { type: "string" } },
			},
		});
	return {
		tools,
		maxToolCalls:
			(readTools.length ? 1 : 0) + (work?.tools.length ?? 0) + (lookup ? 1 : 0),
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
			onCall();
			if (debug && toolCall.name === "read_runs" && debugRunRequested(args)) {
				const target = debug.target(input.conversationId, input.runId, args);
				if (Array.isArray(target))
					return {
						content: JSON.stringify({
							candidates: target,
							instruction:
								"記録された候補です。利用者がどの実行を指しているか曖昧な場合は確認してください。",
						}),
					};
				if (!target)
					return {
						content: JSON.stringify({
							code: "debug_diagnostic_target_unavailable",
						}),
					};
				onDebugTarget(target);
				return { content: "", end: true };
			}
			if (lookup && toolCall.name === LOOKUP_TOOL) {
				const { query } = args as { query?: unknown };
				if (typeof query !== "string" || !query.trim() || query.length > 2000)
					return { content: JSON.stringify({ code: "lookup_query_invalid" }) };
				try {
					const result = await lookup(query.trim(), turn.signal);
					turn.lookupSources.push(...result.sources);
					turn.exchange.push({
						name: LOOKUP_TOOL,
						arguments: toolCall.arguments,
						result,
					});
					return { content: JSON.stringify(result) };
				} catch {
					turn.signal.throwIfAborted();
					return { content: JSON.stringify({ code: "lookup_unavailable" }) };
				}
			}
			if (work?.handles(toolCall.name)) {
				const before = turn.exchange.length;
				const answer = await work.call(
					toolCall.name,
					args as Record<string, unknown>,
				);
				if (turn.exchange.length === before && carriesExchange(toolCall.name))
					turn.exchange.push({
						name: toolCall.name,
						arguments: toolCall.arguments,
						result: parseJsonOrText(answer.content),
					});
				return answer;
			}
			const read = await turn.act(
				toolCall.name,
				args as Record<string, unknown>,
			);
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

function debugRunRequested(args: object) {
	const target = (args as { target?: unknown }).target;
	return (
		!!target &&
		typeof target === "object" &&
		"kind" in target &&
		target.kind === "run"
	);
}

function withDebugTarget(parameters: Record<string, unknown>) {
	const properties = parameters.properties as Record<string, unknown>;
	return {
		...parameters,
		properties: {
			...properties,
			target: {
				anyOf: [
					properties.target,
					{
						type: "object",
						required: ["kind"],
						additionalProperties: false,
						properties: {
							kind: { type: "string", enum: ["run"] },
							id: {
								type: "string",
								description:
									"対象の実行または診断のID。直前の依頼なら省略できます。",
							},
						},
					},
				],
			},
		},
	};
}
