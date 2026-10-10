import { expect, test } from "bun:test";
import type { InferencePort, Receipt } from "../../inference";
import { generateConversation } from "../service/conversation-generation";
import { conversationTools } from "../service/conversation-tools";

function fixture(outputs: Partial<Receipt>[]) {
	const seen: Parameters<InferencePort["answer"]>[0][] = [];
	const inference = {
		executeRequest: async () => {
			throw new Error("nonstream_not_expected");
		},
		executeStream: async (
			_id: string,
			messages: Parameters<InferencePort["answer"]>[0],
			_signal: AbortSignal,
			delta: (s: string) => void,
		) => {
			seen.push(messages);
			const output = outputs.shift();
			if (!output) throw new Error("extra_call");
			if (output.value) delta(output.value as string);
			return {
				requestId: "request",
				attemptId: String(seen.length),
				value: "",
				...output,
			};
		},
	} as unknown as InferencePort;
	let repairs = 0;
	const deltas: string[] = [];
	return {
		seen,
		deltas,
		repairs: () => repairs,
		run: () =>
			generateConversation({
				inference,
				requestId: "request",
				messages: [
					{ role: "assistant", content: "鎌倉の話です。" },
					{ role: "user", content: "明日は？" },
				],
				signal: AbortSignal.timeout(1000),
				delta: (s) => deltas.push(s),
				tools: conversationTools(false),
				repair: () => repairs++,
			}),
	};
}
test("ordinary dialogue streams one call and keeps preceding conversational context", async () => {
	const h = fixture([{ value: "明日の予定でございます。" }]);
	const result = await h.run();
	expect(h.seen).toHaveLength(1);
	expect(h.seen[0]![0]!.content).toBe("鎌倉の話です。");
	expect(h.deltas).toEqual([result.text]);
	expect(result.operation).toBeUndefined();
});
test("one native research operation publishes no control text", async () => {
	const h = fixture([
		{
			toolCalls: [
				{
					id: "call",
					name: "research",
					arguments: JSON.stringify({
						kind: "web",
						question: "明日の鎌倉の天気",
					}),
				},
			],
		},
	]);
	expect((await h.run()).operation).toEqual({
		kind: "web",
		question: "明日の鎌倉の天気",
	});
	expect(h.seen).toHaveLength(1);
	expect(h.deltas).toEqual([]);
});
test("malformed native arguments get exactly one structural correction", async () => {
	const bad = { toolCalls: [{ id: "call", name: "research", arguments: "{" }] };
	const h = fixture([bad, { value: "対象の地域を教えてください。" }]);
	expect((await h.run()).text).toContain("地域");
	expect(h.repairs()).toBe(1);
	expect(h.seen).toHaveLength(2);
	expect(h.seen[1]!.at(-1)!.content).toContain("一度だけ修正");
	const repeated = fixture([bad, bad]);
	await expect(repeated.run()).rejects.toThrow(
		"invalid_conversation_operation",
	);
	expect(repeated.seen).toHaveLength(2);
});
test("aborted generation never starts a correction", async () => {
	const inference = {
		executeRequest: async () => {
			throw new Error("unexpected");
		},
		executeStream: async () => {
			throw new Error("cancelled");
		},
	} as unknown as InferencePort;
	let repair = 0;
	await expect(
		generateConversation({
			inference,
			requestId: "r",
			messages: [],
			signal: AbortSignal.timeout(1000),
			delta: () => {},
			tools: conversationTools(false),
			repair: () => repair++,
		}),
	).rejects.toThrow("cancelled");
	expect(repair).toBe(0);
});
