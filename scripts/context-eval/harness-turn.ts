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
import {
	decisionMessages,
	decisionSchema,
	headCheck,
	headEnd,
	parseDecision,
	replyCheck,
	turnFacts,
	type LocalCheck,
} from "../../api/domains/dialogue/service/local-turn";
import type { NativeToolCall } from "../../api/infrastructure/chat-stream";
import { generationTools } from "../../api/domains/dialogue/service/generation-tools";
import type {
	CallKind,
	CallSettings,
	ModelClient,
	TaggedCall,
} from "./harness-client";
import {
	DECISION_CHARS,
	HEAD_CHARS,
	accepted,
	cut,
	decisionCall,
	errorCodeOf,
	issuesOf,
	newDetail,
	refused,
	type CallDetail,
} from "./harness-detail";
import type { Turn, TurnMode } from "./harness-judge";

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
	/** Every timed model call of the turn, by which call it was. */
	calls: TaggedCall[];
	/** When a local reply was published (performance.now()), null when no local reply was. */
	publishedAt: number | null;
	/** The checks a local answer failed in this turn, in order. */
	failedChecks: string[];
	/** The cloud answered at least one round. */
	cloudAnswered: boolean;
	/** What each model call did, in order. */
	details: CallDetail[];
	/** Why the turn ended: an answer in words, a hand-over, a failed check, an error, or the rounds ran out. */
	stop: "answer" | "handover" | "check" | "error" | "rounds";
};

/** What a turn runs on. */
export type TurnEnv = {
	client: ModelClient;
	settings: CallSettings;
	mode: TurnMode;
	/** The system-copy check of the harness's gate (absent when the gate is off). */
	copies?: (text: string) => boolean;
	/** The cloud path answering a round whose local answer failed a check (absent: the step fails with the check). */
	cloud: { client: ModelClient; settings: CallSettings } | null;
};

/** Thrown from a reply's delta to stop the call once a check failed (as the app does). */
class HeadFailed extends Error {}

/** One round's answer: words (published at `publishedAt` when the local reply was) and the calls it made. */
type Answer = {
	text: string;
	toolCalls: NativeToolCall[];
	publishedAt: number | null;
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
		return {
			result: { delegated: true, todo: `w${work}` },
			found,
			outcome: `引き渡し ${args.toolchain}`,
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

const OFFERED = generationTools.map((tool) => tool.function.name);

/** Takes the text that arrived into the call's detail. */
const arrived = (detail: CallDetail, delta: string) => {
	detail.textChars += delta.length;
	if (detail.text.length < HEAD_CHARS)
		detail.text = cut(
			`${detail.text}${delta}`.slice(0, HEAD_CHARS),
			HEAD_CHARS,
		);
};

export async function runTurn(
	env: TurnEnv,
	input: ChatMessage[],
	cards: Readonly<Record<string, Card>>,
	work: number,
): Promise<TurnResult> {
	const started = Date.now();
	const steps: ExchangeStep[] = [];
	const calls: TaggedCall[] = [];
	const details: CallDetail[] = [];
	const failedChecks: string[] = [];
	let found: Card[] = [];
	let messages = input;
	let text = "";
	let publishedAt: number | null = null;
	let cloudAnswered = false;
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
		publishedAt,
		failedChecks,
		cloudAnswered,
		details,
		stop,
	});
	/**
	 * Runs one model call and files its timing and detail under `kind`, also when the call is stopped or fails: an
	 * error keeps its code and how much had arrived.
	 */
	const timed = async <T>(
		kind: CallKind,
		client: ModelClient,
		run: (detail: CallDetail) => Promise<T>,
	): Promise<T> => {
		const detail = newDetail(kind);
		details.push(detail);
		let failure: unknown = null;
		try {
			return await run(detail);
		} catch (error) {
			failure = error;
			throw error;
		} finally {
			for (const metrics of await client.take()) {
				calls.push({ kind, metrics });
				detail.reasoningChars += metrics.reasoningChars;
				detail.finishReason ??= metrics.finishReason;
			}
			// A stop of our own (a failed head) is not an error of the call.
			if (failure && !(failure instanceof HeadFailed))
				detail.error = {
					code: errorCodeOf(failure),
					textChars: detail.textChars,
					reasoningChars: detail.reasoningChars,
				};
		}
	};
	const signal = () => AbortSignal.timeout(CALL_TIMEOUT_MS);
	/** The one call that replies or calls a tool (a single turn, or the cloud's answer to a failed round). */
	const singleCall = async (
		kind: "single" | "cloud",
		client: ModelClient,
		settings: CallSettings,
	): Promise<Answer> => {
		const reply = await timed(kind, client, (detail) =>
			client.stream(messages, settings, signal(), (delta) =>
				arrived(detail, delta),
			),
		);
		return { text: reply.text, toolCalls: reply.toolCalls, publishedAt: null };
	};
	/** Why a decision failed its check: the call it names, run through the product's validation to show the issues. */
	const refuseDecision = (
		detail: CallDetail,
		decided: string,
		check: string,
	) => {
		detail.check = check;
		const named = decisionCall(decided);
		if (!named) {
			detail.toolCalls.push(refused("-", "", check));
			return;
		}
		try {
			parseCall({
				id: "diagnosis",
				name: named.name,
				arguments: named.checked,
			});
			detail.toolCalls.push(refused(named.name, named.arguments, check));
		} catch (error) {
			detail.toolCalls.push(
				refused(
					named.name,
					named.arguments,
					check,
					error instanceof ValidationFailure ? issuesOf(error) : undefined,
				),
			);
		}
	};
	/**
	 * The local turn of the app (`runLocalTurn`) with its own checks: a silent decision, then the reply once its head
	 * passes. Returns the check a failed answer failed.
	 */
	const localRound = async (): Promise<Answer | { failed: LocalCheck }> => {
		if (!env.client.decide) throw new Error("harness_decide_unsupported");
		const decided = await timed("decision", env.client, async (detail) => {
			const raw = await env.client.decide!(
				decisionMessages(messages, generationTools),
				env.settings,
				signal(),
				decisionSchema(generationTools),
			);
			detail.decisionJson = cut(raw, DECISION_CHARS);
			detail.textChars = raw.length;
			return raw;
		});
		const detail = details.at(-1)!;
		const decision = parseDecision(decided, OFFERED);
		if (decision.action === "failed") {
			refuseDecision(detail, decided, decision.check);
			return { failed: decision.check };
		}
		if (decision.action === "call")
			return { text: "", toolCalls: [decision.call], publishedAt: null };
		const facts = turnFacts(input, messages.slice(input.length));
		// After a search with candidates the reply is held to its end; otherwise the head releases it.
		const hold = facts.searched;
		let reply = "";
		let headChecked = false;
		let released: number | null = null;
		let failed: LocalCheck | null = null;
		let replyDetail: CallDetail | null = null;
		const onDelta = (part: string) => {
			if (replyDetail) arrived(replyDetail, part);
			if (failed) return;
			reply += part;
			if (headChecked) return;
			const end = headEnd(reply, false);
			if (end === null) return;
			const check = headCheck(reply.slice(0, end), facts, env.copies);
			if (check) {
				failed = check;
				throw new HeadFailed();
			}
			headChecked = true;
			if (!hold) released = performance.now();
		};
		let answered: Awaited<ReturnType<ModelClient["stream"]>>;
		try {
			answered = await timed("reply", env.client, (d) => {
				replyDetail = d;
				return env.client.stream(messages, env.settings, signal(), onDelta, {
					toolChoice: "none",
				});
			});
		} catch (error) {
			if (failed) {
				details.at(-1)!.check = failed;
				return { failed };
			}
			throw error;
		}
		const replied = details.at(-1)!;
		if (failed) {
			replied.check = failed;
			return { failed };
		}
		// A call the model made although none was allowed is a decision, not a reply to check.
		if (answered.toolCalls.length)
			return {
				text: answered.text,
				toolCalls: answered.toolCalls,
				publishedAt: null,
			};
		reply = answered.text;
		if (!headChecked) {
			const check = headCheck(
				reply.slice(0, headEnd(reply, true) ?? reply.length),
				facts,
				env.copies,
			);
			if (check) {
				replied.check = check;
				return { failed: check };
			}
		}
		const check = replyCheck(reply, facts);
		if (check) {
			replied.check = check;
			return { failed: check };
		}
		return {
			text: reply,
			toolCalls: [],
			publishedAt: released ?? performance.now(),
		};
	};

	for (let round = 0; round < ROUNDS; round++) {
		let answer: Answer;
		try {
			if (env.mode === "single")
				answer = await singleCall("single", env.client, env.settings);
			else {
				const local = await localRound();
				if ("failed" in local) {
					failedChecks.push(local.failed);
					if (!env.cloud) {
						text = "";
						return done("check", { localFailure: local.failed });
					}
					cloudAnswered = true;
					answer = await singleCall(
						"cloud",
						env.cloud.client,
						env.cloud.settings,
					);
				} else answer = local;
			}
		} catch (error) {
			text = (details.at(-1)?.text ?? "").slice(0, 200);
			return done("error", { error: (error as Error).message });
		}
		text = answer.text;
		publishedAt = answer.publishedAt ?? publishedAt;
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
