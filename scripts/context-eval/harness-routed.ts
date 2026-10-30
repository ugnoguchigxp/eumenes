/**
 * One turn of the local harness's routed turn in the harness measurement (the local harness rebuild plan, sections
 * 4.2 and 4.3). The host routes the turn: a request turn searches with the user's words (the fixed routing of
 * `candidatesFor`), then makes one silent choice held to the schema of `choiceSchema`, read from the product's
 * `choiceMessages`; a talk turn is one streamed call that offers no tools. The simulated host carries a choice out as
 * the product's `routed-steps.ts` does as far as the saved cards allow: a candidate is handed over (its `say` is the
 * announcement; an instant one answers, here with a fixed sentence), `ask` says its question and carries the ask
 * step, `none` and an answer that is no choice at all go on to the talk turn (the unreadable one is marked as its
 * check). A choice cut at the output limit goes on to talk too. A choice that names what was not offered is made
 * again once with its reason (`retry`); after the second
 * failure the host says its fixed phrase. Confirmations, the
 * toolchains' own input checks and the pending turn are not simulated (the saved cards carry no input schema or
 * minimum impact, and no chain leaves anything pending).
 */
import type { ChatMessage } from "../../api/domains/dialogue/service/context";
import type { RoutedInput } from "../../api/domains/dialogue/service/context";
import { TOOL_NAMES } from "../../api/domains/dialogue/service/generation-tools";
import {
	choiceMessages,
	choiceSchema,
	parseChoice,
	type ChoiceCandidate,
} from "../../api/domains/dialogue/service/routed-choice";
import { askedRequest } from "../../api/domains/dialogue/service/routed-steps";
import {
	ASK_STEP,
	carriedToolCalls,
	type ExchangeStep,
} from "../../api/domains/dialogue/service/tool-exchange";
import { systemContext } from "../../api/infrastructure/system-context";
import { candidatesFor, type Card } from "./harness-chains";
import {
	callSignal,
	createRecorder,
	refs,
	type TurnEnv,
	type TurnResult,
} from "./harness-calls";
import {
	CHOICE_CHARS,
	accepted,
	arrived,
	cut,
	refused,
} from "./harness-detail";
import type { Turn } from "./harness-judge";

/** Choices one request turn may make: the first, and one more after a choice that could not be carried out. */
export const CHOICE_ROUNDS = 2;
/** The host's fixed phrase when no choice could be carried out (the product's own text). */
export const FAILED_SAID = systemContext("dialogue.contexts.local.failed", {});
/** Stands in for an instant toolchain's answer and for the words of a memory or work operation. */
export const INSTANT_SAID = "担当が答えました。";
export const OPERATION_SAID = "承りました。";

/** What the request turn reads besides the talk input. */
export type RequestInput = {
	routed: RoutedInput;
	/** The user's words. */
	utterance: string;
	/** The persona's tone (`personaStyle`), which the choice's `say` follows. */
	style: string;
};

/** How the host carried one choice out. */
type Settled =
	| { talk: true; check?: string }
	| { retry: string }
	| {
			said: string;
			stop: "answer" | "handover" | "ask";
			outcome: string;
			step?: ExchangeStep;
			delegated?: NonNullable<Turn["delegated"]>;
	  };

const MEMORY_CHOICES = new Set(["memory.recall", "memory.request"]);

/** Carries a parsed choice out on the simulated host. */
function settle(
	chosen: ReturnType<typeof parseChoice>,
	candidates: readonly ChoiceCandidate[],
	input: RequestInput,
	work: number,
): Settled {
	if (!chosen) return { talk: true, check: "choice_unreadable" };
	const say = typeof chosen.say === "string" ? chosen.say : "";
	const choice = chosen.choice;
	if (choice === "none") return { talk: true };
	if (choice === "ask")
		return {
			said: say,
			stop: "ask",
			outcome: "聞き返し",
			step: {
				name: ASK_STEP,
				// The whole request so far, as the product keeps it.
				arguments: JSON.stringify({
					request: askedRequest(input.routed.asked?.request, input.utterance),
				}),
				result: {},
			},
		};
	if (MEMORY_CHOICES.has(choice))
		return {
			said: say || OPERATION_SAID,
			stop: "answer",
			outcome: `記憶 ${choice}`,
		};
	if (/^t\d+$/.test(choice)) {
		if (!input.routed.todos.some((todo) => `t${todo.ref}` === choice))
			return { retry: "choice_not_offered" };
		return {
			said: say || OPERATION_SAID,
			stop: "answer",
			outcome: `仕事 ${choice}`,
		};
	}
	const candidate = candidates.find((c) => c.id === choice);
	if (!candidate) return { retry: "choice_not_offered" };
	if (candidate.execution === "instant")
		return {
			said: INSTANT_SAID,
			stop: "answer",
			outcome: `即答 ${candidate.id}`,
			step: {
				name: TOOL_NAMES.delegate,
				arguments: JSON.stringify({
					mode: "execute",
					toolchain: candidate.id,
					impact: "none",
					inputs: chosen.inputs ?? {},
				}),
				result: { answered: true },
			},
		};
	const inputs =
		chosen.inputs &&
		typeof chosen.inputs === "object" &&
		!Array.isArray(chosen.inputs)
			? chosen.inputs
			: null;
	const request = typeof chosen.request === "string" ? chosen.request : "";
	// A pipeline takes its inputs; any other work its request.
	if (candidate.execution === "pipeline" ? !inputs : !request.trim())
		return {
			retry:
				candidate.execution === "pipeline"
					? "inputs_required"
					: "request_required",
		};
	return {
		said: say,
		stop: "handover",
		outcome: `引き渡し ${candidate.id}`,
		step: {
			name: TOOL_NAMES.delegate,
			arguments: JSON.stringify({
				mode: "execute",
				toolchain: candidate.id,
				announcement: say,
				...(request ? { request } : {}),
				...(inputs ? { inputs } : {}),
			}),
			result: { delegated: true, todo: `w${work}` },
		},
		delegated: {
			toolchain: candidate.id,
			request: request || JSON.stringify(inputs),
		},
	};
}

/**
 * The routed turn. `talk` is the composed talk input; `request` is the request turn's input, or null when the judge
 * (here the step's expectation stands in for it) found no request, and the turn only talks.
 */
export async function runRoutedTurn(
	env: TurnEnv,
	talk: ChatMessage[],
	cards: Readonly<Record<string, Card>>,
	work: number,
	request: RequestInput | null,
): Promise<TurnResult> {
	const started = Date.now();
	const steps: ExchangeStep[] = [];
	const { calls, details, timed } = createRecorder();
	let text = "";
	let hostSpoke = false;
	const done = (
		stop: TurnResult["stop"],
		extra: Partial<Turn> = {},
	): TurnResult => ({
		said: text,
		acted: request !== null,
		...extra,
		toolCalls: carriedToolCalls(steps, refs),
		ms: Date.now() - started,
		calls,
		hostSpoke,
		details,
		stop,
	});
	/** The talk turn: one streamed call with no tools, stopped when it copies the system part (as the app does). */
	const talkTurn = async (): Promise<TurnResult> => {
		try {
			let heard = "";
			const reply = await timed("talk", env.client, (detail) =>
				env.client.stream(
					talk,
					env.settings,
					callSignal(),
					(delta) => {
						arrived(detail, delta);
						heard += delta;
						if (env.copies?.(heard)) throw new Error("system_text_copied");
					},
					{ tools: false },
				),
			);
			text = reply.text;
			return done("answer");
		} catch (error) {
			text = (details.at(-1)?.text ?? "").slice(0, 200);
			return done("error", { error: (error as Error).message });
		}
	};
	if (!request) return talkTurn();
	if (!env.client.decide)
		return done("error", { error: "harness_decide_unsupported" });

	const { routed, utterance, style } = request;
	const query = routed.asked
		? `${routed.asked.request}\n${utterance}`
		: utterance;
	const candidates: ChoiceCandidate[] = candidatesFor(cards, query);
	steps.push({
		name: TOOL_NAMES.search,
		arguments: JSON.stringify({ query }),
		result: { candidates },
	});
	const schema = choiceSchema(candidates, routed);
	let retry: string | undefined;
	for (let round = 0; round < CHOICE_ROUNDS; round++) {
		let raw: string;
		try {
			raw = await timed("choice", env.client, async (detail) => {
				const answered = await env.client.decide!(
					choiceMessages({
						style,
						routed,
						candidates,
						utterance,
						...(retry ? { retry } : {}),
					}),
					env.settings,
					callSignal(),
					schema,
				);
				detail.choiceJson = cut(answered, CHOICE_CHARS);
				detail.textChars = answered.length;
				return answered;
			});
		} catch (error) {
			// Like the product's request turn, a cut has no completed choice to correct.
			if (error instanceof Error && error.message === "chat_stream_incomplete")
				return talkTurn();
			return done("error", { error: (error as Error).message });
		}
		const detail = details.at(-1)!;
		const chosen = parseChoice(raw);
		const settled = settle(chosen, candidates, request, work);
		if ("talk" in settled) {
			if (settled.check) {
				// The product makes no choice again on an unreadable answer: the talk turn answers.
				detail.check = settled.check;
				detail.toolCalls.push(refused("-", raw, settled.check));
			} else detail.toolCalls.push(accepted("none", raw, "会話の回へ"));
			return talkTurn();
		}
		if ("retry" in settled) {
			retry = settled.retry;
			detail.check = retry;
			detail.toolCalls.push(refused(chosen?.choice ?? "-", raw, retry));
			continue;
		}
		detail.toolCalls.push(accepted(chosen!.choice, raw, settled.outcome));
		if (settled.step) steps.push(settled.step);
		text = settled.said;
		hostSpoke = true;
		return done(
			settled.stop,
			settled.delegated ? { delegated: settled.delegated } : {},
		);
	}
	text = FAILED_SAID;
	hostSpoke = true;
	return done("check", { choiceFailure: retry! });
}
