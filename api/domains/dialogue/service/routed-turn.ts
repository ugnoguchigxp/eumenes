import type { CallSession, Receipt } from "../../inference";
import type { SpeechPreparation } from "../../delivery";
import { getLogger, withLogContext } from "../../../infrastructure/logger";
import { systemContext } from "../../../infrastructure/system-context";
import { ValidationFailure } from "../../../infrastructure/validation-log";
import type { AgentMessage } from "../contracts";
import type { ChatMessage, DialogueDeps, GenerateInput } from "./context";
import { conversationOutput } from "./conversation-output";
import type {
	GenerationOutcome,
	ToolExecutor,
	ToolOutcome,
} from "./generation-loop";
import { TOOL_NAMES, parseCall } from "./generation-tools";
import { cloudHarness } from "./harness";
import { INPUT_HEADINGS } from "./input-text";
import { openIntentGate } from "./intent-gate";
import { refusalText, toolResultText } from "./result-text";
import { parseChoice } from "./routed-choice";
import { pendingTurn, requestTurn, type Step } from "./routed-steps";
import { carriesExchange, type ExchangeStep } from "./tool-exchange";

const log = getLogger("dialogue");
/** The host's words for a turn whose call failed before anything was said. */
const SAID_FAILED = systemContext("dialogue.contexts.local.turn-failed", {});

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
	"chat_output_empty",
	"chat_stream_incomplete",
	"chat_stream_too_large",
	"chat_output_too_large",
	"chat_frame_too_large",
	"chat_stream_error",
	"system_text_copied",
]);

/**
 * One turn of the local harness (the local harness rebuild plan, section 4): the host routes it by what it holds
 * pending and the user-intent judge, then the model talks (one call, no tools) or makes one choice held to a schema
 * built from this turn's candidates (no words of its own but `say`). Every word for the user goes out through one
 * mouth, so what was said is the answer.
 */
export async function runRoutedTurn(
	deps: DialogueDeps,
	input: GenerateInput,
	options: RoutedTurnOptions,
): Promise<GenerationOutcome> {
	const turn = createTurn(deps, input, options);
	const { routed } = turn;
	// The judge runs before the first model call, for the user's words only (the intent gate design, section 5).
	const gate = await openIntentGate(deps, input, options.signal);
	let kind: "talk" | "request" | "pending" = "talk";
	try {
		let step: Step = "talk";
		// A choice needs the schema call on the run's request; without it the turn only talks.
		if (input.final.kind === "utterances" && routed && turn.canChoose) {
			if (routed.asked) {
				// The user answers the question the agent asked back: the request turn takes both.
				kind = "request";
				step = await requestTurn(turn);
			} else {
				if (
					routed.pending.confirmations.length ||
					routed.pending.questions.length
				) {
					kind = "pending";
					step = await pendingTurn(turn);
				}
				// `answer`: the judge found no request of work; `search` or no judgement: the request turn decides.
				if (step === "talk" && gate.route !== "answer") {
					kind = "request";
					step = await requestTurn(turn);
				}
			}
		}
		if (step === "talk") await turn.talk();
	} catch (error) {
		const code = error instanceof Error ? error.message : "";
		if (options.signal.aborted || turn.published() || !CALL_FAILURES.has(code))
			throw error;
		log.warn("dialogue.turn_failed", { kind, reason: code });
		turn.answer(SAID_FAILED);
	} finally {
		gate.observe({
			searched: turn.executed.some(
				({ call }) => call.name === TOOL_NAMES.search,
			),
			delegated: turn.executed.some(
				({ call }) => call.name === TOOL_NAMES.delegate,
			),
		});
	}
	log.info("dialogue.turn_routed", { kind, count: turn.calls() });
	options.signal.throwIfAborted();
	const { receipt, emotion } = turn.result();
	return {
		text: turn.said().trim(),
		...(receipt ? { receipt } : {}),
		...(emotion ? { emotion } : {}),
		executed: turn.executed,
		exchange: turn.exchange,
		ended: turn.executed.some(({ outcome }) => outcome.end === true),
	};
}

/** What the steps of one routed turn share: its words, its model calls and its host operations. */
export type Turn = ReturnType<typeof createTurn>;

function createTurn(
	deps: DialogueDeps,
	input: GenerateInput,
	options: RoutedTurnOptions,
) {
	const { signal } = options;
	const executed: GenerationOutcome["executed"] = [];
	const exchange: ExchangeStep[] = [];
	let receipt: Receipt | undefined;
	let said = "";
	let emotion: GenerationOutcome["emotion"];
	let calls = 0;
	let seq = 0;
	let published = false;
	/** Every word for the user goes out here: the run is marked as having said something once a word went. */
	const delta = (text: string) => {
		if (text) published = true;
		options.delta(text);
	};
	const session: CallSession = {
		sessionRole: "main",
		// The turn settles its request itself (a model answer, or the host's words): a failed call ends only that call,
		// so a choice can be made again, the talk turn follow it, or the host answer.
		retainRequest: true,
		outputLimit: input.harness.call.outputLimit,
		reasoning: {
			larm: input.harness.call.reasoning,
			cloud: cloudHarness.call.reasoning,
		},
		...(options.session?.context ? { context: options.session.context } : {}),
		...(options.session?.refs ? { refs: options.session.refs } : {}),
	};

	/** One model call on the run's request: a streamed reply (`onDelta`) or a silent choice (`outputSchema`). */
	const call = (
		messages: ChatMessage[],
		onDelta: ((text: string) => void) | undefined,
		extra: Pick<CallSession, "outputSchema">,
	) => {
		const stream = deps.larm.executeStream;
		if (!input.requestId || !stream) throw new Error("routed_turn_unavailable");
		calls++;
		return withLogContext({ phase: "generation" }, () =>
			stream.call(
				deps.larm,
				input.requestId!,
				messages,
				signal,
				onDelta,
				onDelta ? options.preparation : undefined,
				undefined,
				{ ...session, ...extra },
			),
		);
	};

	return {
		deps,
		input,
		signal,
		routed: input.routed,
		canChoose: !!(input.requestId && deps.larm.executeStream),
		utterance: input.utterances.join("\n"),
		executed,
		exchange,
		calls: () => calls,
		said: () => said,
		published: () => published,
		result: () => ({ receipt, emotion }),

		/** The host's own words: spoken as they are, and part of the answer. */
		speak(text: string) {
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
				answered = await call(messages, undefined, { outputSchema: schema });
			} catch (error) {
				if (signal.aborted || !(error instanceof Error)) throw error;
				if (error.message === "chat_output_empty") return null;
				if (error.message === "chat_stream_incomplete") return "cut";
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
		async act(
			name: string,
			args: Record<string, unknown>,
		): Promise<{ outcome: ToolOutcome } | { refused: ValidationFailure }> {
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
		},

		/** Why the host refused an operation, as the retry reads it. */
		reasonOf(error: ValidationFailure) {
			return error.repair?.length
				? refusalText(error.message, error.repair)
				: toolResultText("refused", { refused: true, issues: error.issues });
		},

		/** The talk turn: one streamed call with no tools; `notice` adds what the host found for it to tell. */
		async talk(notice?: string) {
			const messages = notice
				? withNotice(input.messages, notice)
				: input.messages;
			const system =
				input.harness.gates.systemCopy && messages[0]?.role === "system"
					? messages[0].content
					: undefined;
			const reply = await deps.conversationAgent.respond({
				messages: messages as AgentMessage[],
				chat: {
					async complete(_request, onDelta, chatSignal) {
						const output = conversationOutput(
							onDelta,
							[],
							system,
							input.toolchainTitles,
						);
						// A port without the streamed call answers in one piece, as the agent loop's does.
						if (!input.requestId || !deps.larm.executeStream) {
							const text = await deps.larm.answer(messages, chatSignal);
							output.delta(text);
							return { text: output.finish(text), toolCalls: [] };
						}
						try {
							const answered = await call(messages, output.delta, {});
							chatSignal.throwIfAborted();
							receipt = answered;
							return {
								text: output.finish(String(answered.value ?? "")),
								toolCalls: [],
							};
						} catch (error) {
							// A call that ended cleanly with nothing to say: the reply says nothing, as the system allows.
							if (
								!chatSignal.aborted &&
								error instanceof Error &&
								error.message === "chat_output_empty"
							)
								return { text: output.finish(""), toolCalls: [] };
							throw error;
						}
					},
				},
				tools: { tools: [], call: async () => ({ content: "" }) },
				signal,
				onDelta: delta,
				maxToolCalls: 0,
			});
			// The user spoke and was told nothing: a failed reply, not silence (a notice may go unanswered).
			if (
				!reply.text.trim() &&
				!said.trim() &&
				input.final.kind === "utterances"
			)
				throw new Error("chat_output_empty");
			emotion = reply.emotion;
			said = [said, reply.text].filter(Boolean).join("\n");
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
