import { expect, test } from "bun:test";
import type { ChatMessage } from "../../api/domains/dialogue/service/context";
import { CARD_IDS } from "./harness-chains";
import { judgeStep } from "./harness-judge";
import type { CallKind, CallMetrics, ModelClient } from "./harness-client";
import {
	FAILED_SAID,
	runRoutedTurn,
	type RequestInput,
} from "./harness-routed";

const request: RequestInput = {
	style: "丁寧",
	utterance: "絵を描いて",
	routed: {
		memory: null,
		earlier: [],
		state: "## State\n今: 10-30（金）14:00",
		previousReply: null,
		asked: null,
		pending: { confirmations: [], questions: [] },
		todos: [],
		resources: [],
	},
};
const cards = Object.fromEntries(
	CARD_IDS.map((id) => [id, { id, title: id, summary: "", useWhen: [] }]),
);

/** Synthetic timings for all calls, including failures: the recorder must keep the failed choice too. */
const metric = (finishReason: string | null): CallMetrics => ({
	startedAt: 0,
	firstContentMs: null,
	model: null,
	reasoningChars: 0,
	firstTokenMs: null,
	firstTextMs: null,
	totalMs: 1,
	outputTokens: 0,
	tokensFrom: "usage",
	promptTokens: null,
	cachedPromptTokens: null,
	requestedLimit: 4096,
	finishReason,
	tokensPerSecond: null,
});

async function choiceTurn(script: Array<string | Error>, talkError?: string) {
	const replies = [...script];
	const pending: CallMetrics[] = [];
	const choices: ChatMessage[][] = [];
	const streams: Array<{ tools?: false } | undefined> = [];
	const client: ModelClient = {
		async connect() {},
		async close() {},
		async take() {
			return pending.splice(0);
		},
		async decide(messages) {
			choices.push(messages);
			const reply = replies.shift();
			if (reply === undefined) throw new Error("fixture_choice_missing");
			pending.push(
				metric(
					reply instanceof Error
						? reply.message === "chat_stream_incomplete"
							? "length"
							: null
						: "stop",
				),
			);
			if (reply instanceof Error) throw reply;
			return reply;
		},
		async stream(_messages, _settings, _signal, onDelta, extra) {
			streams.push(extra);
			pending.push(metric(talkError ? null : "stop"));
			if (talkError) throw new Error(talkError);
			onDelta("決めきれませんでした。");
			return { text: "決めきれませんでした。", toolCalls: [] };
		},
	};
	const result = await runRoutedTurn(
		{ client, settings: { reasoning: "low", outputLimit: 4096 } },
		[{ role: "user", content: request.utterance }],
		cards,
		1,
		request,
	);
	return { result, choices, streams, client };
}

test.each([false, true])(
	"a cut passes to talk and retains call metrics, after refusal: %s",
	async (afterRefusal) => {
		const { result, choices, streams } = await choiceTurn([
			...(afterRefusal ? [JSON.stringify({ choice: "not.offered" })] : []),
			new Error("chat_stream_incomplete"),
		]);
		const attempts = afterRefusal ? 2 : 1;
		expect(choices).toHaveLength(attempts);
		expect(streams).toEqual([{ tools: false }]);
		expect(result).toMatchObject({
			stop: "answer",
			said: "決めきれませんでした。",
			hostSpoke: false,
		});
		const kinds: CallKind[] = [
			...Array.from({ length: attempts }, (): CallKind => "choice"),
			"talk",
		];
		expect(result.calls.map((call) => call.kind)).toEqual(kinds);
		expect(result.details.map((detail) => detail.kind)).toEqual(kinds);
		expect(result.details[attempts - 1]).toMatchObject({
			finishReason: "length",
			error: { code: "chat_stream_incomplete" },
		});
		if (afterRefusal)
			expect(choices[1]!.at(-1)!.content).toContain("choice_not_offered");
	},
);

test("a talk failure after a cut remains an error, with both calls recorded", async () => {
	const { result, choices, streams } = await choiceTurn(
		[new Error("chat_stream_incomplete")],
		"chat_stream_too_large",
	);
	expect(choices).toHaveLength(1);
	expect(streams).toHaveLength(1);
	expect(result).toMatchObject({
		stop: "error",
		error: "chat_stream_too_large",
	});
	expect(result.calls.map((call) => call.kind)).toEqual(["choice", "talk"]);
	expect(result.details.map((detail) => detail.error?.code)).toEqual([
		"chat_stream_incomplete",
		"chat_stream_too_large",
	]);
});

test("an unreadable choice passes to talk and keeps its failed check", async () => {
	const { result, choices } = await choiceTurn(["not json"]);
	expect(choices).toHaveLength(1);
	expect(result.calls.map((call) => call.kind)).toEqual(["choice", "talk"]);
	expect(result).toMatchObject({
		stop: "answer",
		said: "決めきれませんでした。",
	});
	expect(result.details[0]).toMatchObject({
		check: "choice_unreadable",
		choiceJson: "not json",
	});
	expect(result.details[0]!.toolCalls[0]).toMatchObject({
		verdict: "refused",
		reason: "choice_unreadable",
	});
});

test("other choice errors end the turn without calling talk", async () => {
	const { result, choices, streams, client } = await choiceTurn([
		new Error("larm_unreachable"),
	]);
	expect(choices).toHaveLength(1);
	expect(streams).toHaveLength(0);
	expect(result).toMatchObject({ stop: "error", error: "larm_unreachable" });
	expect(result.details[0]!.error?.code).toBe("larm_unreachable");
	const unsupported = await runRoutedTurn(
		{
			client: { ...client, decide: undefined },
			settings: { reasoning: "low", outputLimit: 4096 },
		},
		[{ role: "user", content: request.utterance }],
		cards,
		1,
		request,
	);
	expect(unsupported).toMatchObject({
		stop: "error",
		error: "harness_decide_unsupported",
	});
	expect(unsupported.details).toHaveLength(0);
});

test("after two host refusals the host says its fixed phrase and the step fails", async () => {
	const rejected = JSON.stringify({ choice: "not.offered" });
	const { result, choices, streams } = await choiceTurn([rejected, rejected]);
	expect(choices).toHaveLength(2);
	expect(streams).toHaveLength(0);
	expect(result.calls.map((call) => call.kind)).toEqual(["choice", "choice"]);
	expect(result).toMatchObject({
		stop: "check",
		said: FAILED_SAID,
		hostSpoke: true,
		choiceFailure: "choice_not_offered",
	});
	expect(FAILED_SAID.length).toBeGreaterThan(0);
	expect(
		judgeStep({ say: "x", free: true }, result, {
			copies: () => false,
			lastAgent: "",
		}),
	).toEqual({ pass: false, why: "choice:choice_not_offered" });
});
