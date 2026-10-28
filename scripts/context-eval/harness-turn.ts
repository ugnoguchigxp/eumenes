/**
 * One turn of the harness measurement: the model's calls run against a simulated host until it hands the work over
 * or answers in words. The host checks each call with the product's own `parseCall`, shows results as the product
 * does (`toolResultText`) and keeps the turn's exchange as the product carries it (`carriedToolCalls`). A search
 * returns the saved toolchain cards by a fixed routing; a hand-over ends the turn.
 */
import type { UtteranceToolCall } from "../../api/domains/conversation";
import type { ChatMessage } from "../../api/domains/dialogue/service/context";
import {
	parseCall,
	TOOL_NAMES,
} from "../../api/domains/dialogue/service/generation-tools";
import { MAX_TOOL_CALLS } from "../../api/domains/dialogue/service/generation-loop";
import { toolResultText } from "../../api/domains/dialogue/service/result-text";
import {
	carriedToolCalls,
	type ExchangeStep,
} from "../../api/domains/dialogue/service/tool-exchange";
import type { DocumentRefs } from "../../api/domains/dialogue/service/work-items";
import { ValidationFailure } from "../../api/infrastructure/validation-log";
import { candidatesFor, type Card } from "./harness-chains";
import type { CallSettings, ModelClient } from "./harness-client";
import type { Turn } from "./harness-judge";

/** A model call's time limit. */
const CALL_TIMEOUT_MS = 180_000;
/** The model's model calls in one turn (a call per round; the product's loop is bounded the same way). */
const ROUNDS = 4;

/** The numbers the host names works by: the simulated works are `w<n>`, shown as `t<n>`. */
const refs: DocumentRefs = {
	todo: (id) => (id.startsWith("w") ? `t${id.slice(1)}` : null),
	confirmation: () => null,
	resource: () => null,
};

export type TurnResult = Turn & {
	/** What a later turn sees of this one: the carried searches and hand-overs. */
	toolCalls: UtteranceToolCall[];
	ms: number;
};

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
} {
	if (call.name === TOOL_NAMES.search) {
		const next = candidatesFor(cards, call.args.query);
		return { result: { candidates: next }, found: next };
	}
	if (call.name === TOOL_NAMES.delegate) {
		const args = call.args;
		if (args.mode === "approve" || !found.some((f) => f.id === args.toolchain))
			return {
				result: { delegated: false, code: "toolchain_not_found" },
				found,
			};
		return {
			result: { delegated: true, todo: `w${work}` },
			found,
			handedOver: {
				request: args.request,
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
	client: ModelClient,
	input: ChatMessage[],
	settings: CallSettings,
	cards: Readonly<Record<string, Card>>,
	work: number,
): Promise<TurnResult> {
	const started = Date.now();
	const steps: ExchangeStep[] = [];
	let found: Card[] = [];
	let messages = input;
	let text = "";
	const done = (extra: Partial<Turn>): TurnResult => ({
		said: text,
		acted: steps.some(
			(s) => s.name === TOOL_NAMES.search || s.name === TOOL_NAMES.delegate,
		),
		...extra,
		toolCalls: carriedToolCalls(steps, refs),
		ms: Date.now() - started,
	});
	for (let round = 0; round < ROUNDS; round++) {
		let streamed = "";
		let reply: Awaited<ReturnType<ModelClient["stream"]>>;
		try {
			reply = await client.stream(
				messages,
				settings,
				AbortSignal.timeout(CALL_TIMEOUT_MS),
				(delta) => {
					streamed += delta;
				},
			);
		} catch (error) {
			text = streamed.slice(0, 200);
			return done({ error: (error as Error).message });
		}
		text = reply.text;
		if (!reply.toolCalls.length) break;
		const results: ChatMessage[] = [];
		for (const raw of reply.toolCalls) {
			let content: string;
			try {
				const call = parseCall(raw);
				if (steps.length >= MAX_TOOL_CALLS)
					throw new ValidationFailure("tool_call_limit", [
						{ reason: "tool_call_limit" },
					]);
				const answer = hostAnswer(call, found, cards, work);
				found = answer.found;
				steps.push({
					name: raw.name,
					arguments: raw.arguments,
					result: answer.result,
				});
				if (answer.handedOver) {
					text = answer.handedOver.announcement || text;
					return done({
						delegated: {
							toolchain: answer.handedOver.toolchain,
							request: answer.handedOver.request,
						},
					});
				}
				content = toolResultText(raw.name, answer.result);
			} catch (error) {
				if (!(error instanceof ValidationFailure)) throw error;
				steps.push({
					name: raw.name,
					arguments: raw.arguments,
					result: { refused: true },
				});
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
				content: reply.text,
				tool_calls: reply.toolCalls.map((c) => ({
					id: c.id,
					type: "function",
					function: { name: c.name, arguments: c.arguments },
				})),
			},
			...results,
		];
	}
	return done({});
}
