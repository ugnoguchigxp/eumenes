/**
 * One turn of the reply loop (`single`) in the harness measurement: the model's calls run against a simulated host
 * until it hands the work over or answers in words (the routed turn is `harness-routed.ts`). The host checks each
 * call with the product's own `parseCall`, shows results as the product does (`toolResultText`) and keeps the turn's exchange as the product carries it (`carriedToolCalls`). A search
 * returns the saved toolchain cards by a fixed routing; a hand-over ends the turn.
 */
import type { ChatMessage } from "../../api/domains/dialogue/service/context";
import {
	parseCall,
	requestRequired,
	TOOL_NAMES,
} from "../../api/domains/dialogue/service/generation-tools";
import { MAX_TOOL_CALLS } from "../../api/domains/dialogue/service/generation-loop";
import { toolResultText } from "../../api/domains/dialogue/service/result-text";
import {
	carriedToolCalls,
	type ExchangeStep,
} from "../../api/domains/dialogue/service/tool-exchange";
import { ValidationFailure } from "../../api/infrastructure/validation-log";
import { candidatesFor, type Card } from "./harness-chains";
import type { ModelClient } from "./harness-client";
import {
	callSignal,
	createRecorder,
	refs,
	type TurnEnv,
	type TurnResult,
} from "./harness-calls";
import { accepted, arrived, issuesOf, refused } from "./harness-detail";
import type { Turn } from "./harness-judge";

/** The model's model calls in one turn (a call per round; the product's loop is bounded the same way). */
const ROUNDS = 4;

/** The host's answer to one parsed call, and the hand-over when the call made one. */
function hostAnswer(
	call: ReturnType<typeof parseCall>,
	found: Card[],
	cards: Readonly<Record<string, Card>>,
	work: number,
): {
	result: unknown;
	found: Card[];
	handedOver?: { request: string; toolchain: string; announcement: string };
	/** The simulated host's own reason for not taking the call. */
	refusal?: string;
	/** What the host answered, in a few words. */
	outcome?: string;
} {
	if (call.name === TOOL_NAMES.search) {
		const next = candidatesFor(cards, call.args.query);
		return {
			result: { candidates: next },
			found: next,
			outcome: `候補 ${next.map((c) => c.id).join(", ")}`,
		};
	}
	if (call.name === TOOL_NAMES.delegate) {
		const args = call.args;
		if (args.mode === "approve")
			return {
				result: { delegated: false, code: "toolchain_not_found" },
				found,
				refusal: "approve_not_simulated",
			};
		if (!found.some((f) => f.id === args.toolchain))
			return {
				result: { delegated: false, code: "toolchain_not_found" },
				found,
				refusal: `toolchain_not_found（探した候補: ${found.map((f) => f.id).join(", ") || "なし"}）`,
			};
		// An instant toolchain answers from its inputs; any other is refused without the request, as the host does.
		if (!args.request && cards[args.toolchain]?.execution !== "instant")
			throw requestRequired();
		return {
			result: { delegated: true, todo: `w${work}` },
			found,
			outcome: `引き渡し ${args.toolchain}`,
			handedOver: {
				request: args.request ?? "",
				toolchain: args.toolchain,
				announcement: args.announcement ?? "",
			},
		};
	}
	return {
		result: call.name === TOOL_NAMES.memory ? { items: [] } : {},
		found,
	};
}

export async function runTurn(
	env: TurnEnv,
	input: ChatMessage[],
	cards: Readonly<Record<string, Card>>,
	work: number,
): Promise<TurnResult> {
	const started = Date.now();
	const steps: ExchangeStep[] = [];
	const { calls, details, timed } = createRecorder();
	let found: Card[] = [];
	let messages = input;
	let text = "";
	const done = (
		stop: TurnResult["stop"],
		extra: Partial<Turn> = {},
	): TurnResult => ({
		said: text,
		acted: steps.some(
			(s) => s.name === TOOL_NAMES.search || s.name === TOOL_NAMES.delegate,
		),
		...extra,
		toolCalls: carriedToolCalls(steps, refs),
		ms: Date.now() - started,
		calls,
		hostSpoke: !!extra.delegated,
		details,
		stop,
	});

	for (let round = 0; round < ROUNDS; round++) {
		let answer: Awaited<ReturnType<ModelClient["stream"]>>;
		try {
			answer = await timed("single", env.client, (detail) =>
				env.client.stream(messages, env.settings, callSignal(), (delta) =>
					arrived(detail, delta),
				),
			);
		} catch (error) {
			text = (details.at(-1)?.text ?? "").slice(0, 200);
			return done("error", { error: (error as Error).message });
		}
		text = answer.text;
		if (!answer.toolCalls.length) return done("answer");
		// The verdicts of the calls belong to the model call that made them.
		const origin = details.at(-1)!;
		const results: ChatMessage[] = [];
		for (const raw of answer.toolCalls) {
			let content: string;
			try {
				const call = parseCall(raw);
				if (steps.length >= MAX_TOOL_CALLS)
					throw new ValidationFailure("tool_call_limit", [
						{ reason: "tool_call_limit" },
					]);
				const hosted = hostAnswer(call, found, cards, work);
				found = hosted.found;
				steps.push({
					name: raw.name,
					arguments: raw.arguments,
					result: hosted.result,
				});
				origin.toolCalls.push(
					hosted.refusal
						? refused(raw.name, raw.arguments, hosted.refusal)
						: accepted(raw.name, raw.arguments, hosted.outcome),
				);
				if (hosted.handedOver) {
					text = hosted.handedOver.announcement || text;
					return done("handover", {
						delegated: {
							toolchain: hosted.handedOver.toolchain,
							request: hosted.handedOver.request,
						},
					});
				}
				content = toolResultText(raw.name, hosted.result);
			} catch (error) {
				if (!(error instanceof ValidationFailure)) throw error;
				steps.push({
					name: raw.name,
					arguments: raw.arguments,
					result: { refused: true },
				});
				origin.toolCalls.push(
					refused(raw.name, raw.arguments, error.message, issuesOf(error)),
				);
				content = toolResultText("refused", {
					refused: true,
					issues: error.issues,
					...(error.repair?.length ? { fields: error.repair } : {}),
				});
			}
			results.push({ role: "tool", tool_call_id: raw.id, content });
		}
		messages = [
			...messages,
			{
				role: "assistant",
				content: answer.text,
				tool_calls: answer.toolCalls.map((c) => ({
					id: c.id,
					type: "function",
					function: { name: c.name, arguments: c.arguments },
				})),
			},
			...results,
		];
	}
	return done("rounds");
}
