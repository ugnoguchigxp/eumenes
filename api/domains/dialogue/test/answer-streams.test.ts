import { expect, test } from "bun:test";
import {
	createAnswerStreams,
	type AnswerStream,
} from "../service/answer-streams";

test("a late subscriber receives only the current generation and superseded producers cannot publish", () => {
	const streams = createAnswerStreams();
	const caller = new AbortController();
	const first = streams.open("run", "first", caller.signal);
	first("以前の本文。");
	const received: AnswerStream[] = [];
	const stop = streams.subscribe("run", (value) => received.push(value));
	const second = streams.open("run", "second", caller.signal);
	expect(received[0]?.signal.aborted).toBe(true);
	expect(() => first("古い結果。")).toThrow("generation_replaced");
	second("新しい本文。");
	expect(
		received.map(({ generationId, text }) => [generationId, text]),
	).toEqual([
		["first", "以前の本文。"],
		["second", ""],
		["second", "新しい本文。"],
	]);
	stop();
	second("購読終了後。");
	expect(received).toHaveLength(3);
	streams.close();
});

test("abort clears buffered text immediately and late subscribers cannot replay it", () => {
	const streams = createAnswerStreams();
	const caller = new AbortController();
	const send = streams.open("run", "generation", caller.signal);
	send("取消される本文。");
	caller.abort(new Error("cancelled"));
	expect(() => send("遅い結果。")).toThrow("cancelled");
	const received: AnswerStream[] = [];
	streams.subscribe("run", (value) => received.push(value));
	expect(received).toEqual([]);
	expect([...streams.runIds()]).toEqual([]);
	streams.close();
});

test("adoption releases the buffer without revoking audio already synthesized", () => {
	const streams = createAnswerStreams();
	const caller = new AbortController();
	streams.open("run", "generation", caller.signal)("本文。");
	let signal: AbortSignal | undefined;
	streams.subscribe("run", (value) => (signal = value.signal));
	streams.retire("run");
	expect(signal?.aborted).toBe(false);
	const received: AnswerStream[] = [];
	streams.subscribe("run", (value) => received.push(value));
	expect(received).toEqual([]);
	streams.close();
});

test("disposing an old subscription twice cannot remove a later subscriber", () => {
	const streams = createAnswerStreams();
	const send = streams.open("run", "generation", new AbortController().signal);
	const stopOld = streams.subscribe("run", () => {});
	stopOld();
	const received: string[] = [];
	streams.subscribe("run", ({ text }) => received.push(text));
	stopOld();
	send("次の本文。");
	expect(received).toEqual(["", "次の本文。"]);
	streams.close();
});

test("a subscriber whose initial replay throws is removed instead of leaking without a disposal handle", () => {
	const streams = createAnswerStreams();
	const send = streams.open("run", "generation", new AbortController().signal);
	let calls = 0;
	expect(() =>
		streams.subscribe("run", () => {
			calls++;
			throw new Error("observer_failed");
		}),
	).toThrow("observer_failed");
	send("次の本文。");
	expect(calls).toBe(1);
	streams.close();
});
