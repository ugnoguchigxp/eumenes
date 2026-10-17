/**
 * The two-round start of a conversation (the design 2026-10-17, section 8): the candidate toolchains are found
 * before the first round, which classifies the request from the role, the exchange just before it and the
 * request itself by calling one function; a toolchain's function carries the notice to the user, and the second
 * round writes the request for it (or, for `answer`, answers) while the notice is read.
 */
import { afterEach, expect, test } from "bun:test";
import { configureLogging } from "../../../infrastructure/logger";
import { setup, type Harness } from "./specialist.fixture";
import {
	PREVIOUS_MESSAGE_MAX_CHARS,
	previousExchange,
} from "../service/request-analysis";
import type { HistoryTurn } from "../service/context-assembly";

afterEach(() => configureLogging({ level: "silent" }));

const reply = (text: string) => ({ action: "reply", text });
const recordOf = (history: Array<{ content: string }>) => {
	const record = history.find((m) => m.content.startsWith("requestAnalysis"));
	return record
		? JSON.parse(record.content.slice(record.content.indexOf("=") + 1))
		: undefined;
};
const WEATHER = {
	call: "studio_create",
	kind: "live_info",
	freshness: "live",
	impact: "none",
} as const;
const capture = () => {
	const lines: string[] = [];
	configureLogging({
		level: "info",
		destination: { write: (line) => void lines.push(line) },
	});
	return (event: string) =>
		lines.map((line) => JSON.parse(line)).filter((row) => row.event === event);
};
const roles = (h: Harness, index: number) =>
	h.state.analysisCalls[index]!.history.map((m) => m.role);
const bodiesOf = (h: Harness, runId: string) => {
	const bodies: string[] = [];
	const stop = h.dialogue.subscribeProgress(runId, (p) => {
		if (p.text) bodies.push(p.text);
	});
	return { bodies, stop };
};

test("live information is classified with the candidates, announced by the first round and written for the specialist by the second", async () => {
	const events = capture();
	const h = await setup();
	try {
		h.state.analyses.push({ ...WEATHER, announcement: "お調べします。" });
		h.startCall({ request: "鎌倉の今日の天気" });
		h.state.specialist.push(reply("担当が答えます。"));
		const run = await h.ask("今日の鎌倉の天気を教えて");
		expect(run.status).toBe("completed");
		expect(run.announcement).toBe("お調べします。");
		// The candidates are searched by the utterance as said, before the first round.
		expect(h.state.routeTexts).toEqual(["今日の鎌倉の天気を教えて"]);
		// The first round offers the candidates, answer and report_unavailable; none of them takes the request.
		expect(h.state.analysisCalls).toHaveLength(1);
		const first = h.state.analysisCalls[0]!.tools;
		expect(first.map((t) => t.function.name)).toEqual([
			"studio_create",
			"other_create",
			"answer",
			"report_unavailable",
		]);
		expect(
			Object.keys(first[0]!.function.parameters.properties as object),
		).toEqual(["kind", "freshness", "impact", "approved", "announcement"]);
		// The second round offers the chosen function only, with the request and no notice.
		const second = h.state.mainCalls[0]!;
		expect(second.tools.map((t) => t.function.name)).toEqual(["studio_create"]);
		expect(
			Object.keys(second.tools[0]!.function.parameters.properties as object),
		).not.toContain("announcement");
		// The analysis record is no part of the second round.
		expect(recordOf(second.history)).toBeUndefined();
		expect(second.history.at(-1)!.content).toBe("今日の鎌倉の天気を教えて");
		// The trace keeps the judgment, never the request.
		expect(h.state.recorded).toHaveLength(1);
		expect(h.state.recorded[0]).toMatchObject({
			decision: "toolchain",
			functionName: "studio_create",
			request: "鎌倉の今日の天気",
			analysis: {
				kind: "live_info",
				freshness: "live",
				next: "toolchain",
				impact: "none",
				approved: false,
			},
		});
		expect(JSON.stringify(h.state.recorded[0]!.analysis)).not.toContain("鎌倉");
		// The log has the judgment only.
		const analyzed = events("dialogue.request_analyzed");
		expect(analyzed).toHaveLength(1);
		expect(analyzed[0]).toMatchObject({
			kind: "live_info",
			freshness: "live",
			next: "toolchain",
		});
		expect(Object.keys(analyzed[0]!)).not.toContain("impact");
		expect(Object.keys(analyzed[0]!)).not.toContain("approved");
		expect(JSON.stringify(analyzed)).not.toContain("鎌倉");
	} finally {
		await h.close();
	}
});

test("the notice is delivered before the second round, which runs while it is read; the specialist waits for the reading", async () => {
	const h = await setup();
	let release = () => {};
	const playback = new Promise<void>((resolve) => (release = resolve));
	const order: string[] = [];
	h.dialogue.setAnnouncementDelivery(async () => {
		order.push(`delivery-start:${h.state.mainCalls.length}`);
		await playback;
		order.push("delivery-end");
	});
	try {
		h.state.analyses.push({ ...WEATHER, announcement: "お調べします。" });
		h.startCall({ request: "鎌倉の今日の天気" });
		h.state.specialist.push(reply("担当が答えます。"));
		const run = await h.say("今日の鎌倉の天気を教えて", {
			utteranceId: "voice-1",
		});
		// The second round was asked while the playback is still going on.
		await h.until(() => h.state.mainCalls.length === 1);
		expect(order).toEqual(["delivery-start:0"]);
		expect(h.dialogue.get(run.id)?.announcement).toBe("お調べします。");
		expect(h.state.specialistPrompts).toHaveLength(0);
		expect(h.dialogue.get(run.id)?.status).toBe("running");
		release();
		await h.finished(run.id);
		expect(order).toEqual(["delivery-start:0", "delivery-end"]);
		expect(h.dialogue.get(run.id)?.status).toBe("completed");
	} finally {
		release();
		await h.close();
	}
});

test("a second round that fails after the notice stops the reading and fails the run without a delegation", async () => {
	const h = await setup();
	let aborted = false;
	h.dialogue.setAnnouncementDelivery(
		(_run, signal) =>
			new Promise<void>((_resolve, reject) =>
				signal.addEventListener("abort", () => {
					aborted = true;
					reject(new Error("aborted"));
				}),
			),
	);
	try {
		h.state.analyses.push({ ...WEATHER, announcement: "お調べします。" });
		// The second round answers in prose twice: the repair does not help.
		h.state.main.push("自然文で答えます。", "また自然文です。");
		const run = await h.say("今日の鎌倉の天気を教えて", {
			utteranceId: "voice-1",
		});
		const { bodies, stop } = bodiesOf(h, run.id);
		await h.finished(run.id);
		stop();
		const ended = h.dialogue.get(run.id)!;
		expect(ended.status).toBe("failed");
		expect(ended.error).toBe("invalid_conversation_operation");
		// The notice already delivered is no sign of success: no answer, no specialist.
		expect(ended.announcement).toBe("お調べします。");
		expect(h.dialogue.answerText(run.id)).toBeNull();
		expect(bodies).toEqual([]);
		expect(aborted).toBe(true);
		expect(h.state.mainCalls).toHaveLength(2);
		expect(h.state.mainCalls.every((c) => c.tools.length === 1)).toBe(true);
		expect(h.state.specialistPrompts).toHaveLength(0);
		expect(h.state.recorded.at(-1)).toMatchObject({ decision: "rejected" });
	} finally {
		await h.close();
	}
});

test("a notice that cannot be delivered stops the second round and fails the run with the delivery's error", async () => {
	const h = await setup();
	h.state.mainHold = new Promise<void>(() => {});
	h.dialogue.setAnnouncementDelivery(async () => {
		throw new Error("announcement_delivery_failed");
	});
	try {
		h.state.analyses.push({ ...WEATHER, announcement: "お調べします。" });
		h.startCall({ request: "鎌倉の今日の天気" });
		h.state.specialist.push(reply("担当が答えます。"));
		const run = await h.say("今日の鎌倉の天気を教えて", {
			utteranceId: "voice-1",
		});
		// The held second round returns only because the failed delivery aborted it.
		await h.finished(run.id);
		const ended = h.dialogue.get(run.id)!;
		expect(ended.status).toBe("failed");
		expect(ended.error).toBe("announcement_delivery_failed");
		expect(h.dialogue.answerText(run.id)).toBeNull();
		expect(h.state.mainCalls).toHaveLength(1);
		expect(h.state.specialistPrompts).toHaveLength(0);
	} finally {
		await h.close();
	}
});

test("an old answer to the same question, the memory and the time never reach the first round", async () => {
	const h = await setup();
	try {
		h.state.main.push(
			"今日は晴れで、最高気温は22度です。",
			"どういたしまして。",
		);
		await h.ask("今日の鎌倉の天気を教えて");
		await h.ask("ありがとう");
		h.state.analyses.push(WEATHER);
		h.startCall({ request: "鎌倉の今日の天気" });
		h.state.specialist.push(reply("担当が答えます。"));
		const again = await h.ask("今日の鎌倉の天気を教えて");
		expect(again.status).toBe("completed");
		const input = h.state.analysisCalls[2]!.history;
		// The role, the exchange just before, the marker and the request: nothing else.
		expect(roles(h, 2)).toEqual(["system", "user", "system", "system", "user"]);
		expect(
			JSON.parse(input[1]!.content.slice(input[1]!.content.indexOf("=") + 1)),
		).toEqual([
			{ role: "user", content: "ありがとう" },
			{ role: "assistant", content: "どういたしまして。" },
		]);
		// The role only: the spoken-reply and function rules of the answer prompt would invite a reply here.
		expect(input[0]!.content).toContain("役割:");
		expect(input[0]!.content).not.toContain("音声で聞かれます");
		expect(input[2]!.content).toContain("report_unavailable");
		const text = JSON.stringify(input);
		expect(text).not.toContain("22度");
		expect(text).not.toContain("以下は本人について");
		expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}/);
		expect(text).not.toContain("現在日時:");
	} finally {
		await h.close();
	}
});

test("a follow-up is searched by its own words and by the user's utterance before it, so the earlier toolchain stays a candidate", async () => {
	const h = await setup();
	try {
		h.state.main.push("今日は晴れです。");
		await h.ask("鎌倉の天気は？");
		h.state.analyses.push(WEATHER);
		h.startCall({ request: "鎌倉の明日の天気" });
		h.state.specialist.push(reply("担当が答えます。"));
		const run = await h.ask("明日は？");
		expect(run.status).toBe("completed");
		expect(roles(h, 1)).toEqual(["system", "user", "system", "system", "user"]);
		const previous = h.state.analysisCalls[1]!.history[1]!.content;
		expect(JSON.parse(previous.slice(previous.indexOf("=") + 1))).toEqual([
			{ role: "user", content: "鎌倉の天気は？" },
			{ role: "assistant", content: "今日は晴れです。" },
		]);
		expect(h.state.analysisCalls[1]!.history.at(-1)!.content).toBe("明日は？");
		// The first request was searched alone (nothing before it); the follow-up by both utterances, as said.
		expect(h.state.routeTexts).toEqual([
			"鎌倉の天気は？",
			"明日は？",
			"鎌倉の天気は？",
		]);
	} finally {
		await h.close();
	}
});

test("general knowledge is classified as answer and answered in the second round with the kind only, no notice and no specialist", async () => {
	const h = await setup();
	try {
		h.state.main.push("降水確率は雨の降る可能性です。");
		const run = await h.ask("降水確率って何？");
		expect(run.status).toBe("completed");
		expect(run.announcement).toBeNull();
		expect(h.state.recorded).toMatchObject([
			{
				decision: "answer",
				retrieval: "none",
				analysis: { kind: "knowledge", next: "answer" },
			},
		]);
		expect(h.state.analysisCalls).toHaveLength(1);
		expect(h.state.mainCalls).toHaveLength(1);
		expect(h.state.mainCalls[0]!.tools).toEqual([]);
		expect(recordOf(h.state.mainCalls[0]!.history)).toEqual({
			kind: "knowledge",
		});
		expect(h.dialogue.answerText(run.id)).toBe(
			"降水確率は雨の降る可能性です。",
		);
		expect(h.state.specialistPrompts).toHaveLength(0);
	} finally {
		await h.close();
	}
});

test("report_unavailable of the first round is the answer itself, with no second round", async () => {
	const h = await setup();
	try {
		h.state.analyses.push({
			call: "report_unavailable",
			kind: "action",
			reply: "その操作を任せられる担当がありません。",
		});
		const run = await h.ask("何かを作って");
		expect(run.status).toBe("completed");
		expect(run.announcement).toBeNull();
		expect(h.dialogue.answerText(run.id)).toBe(
			"その操作を任せられる担当がありません。",
		);
		expect(h.state.mainCalls).toHaveLength(0);
		expect(h.state.recorded).toMatchObject([
			{
				decision: "answer",
				analysis: { kind: "action", next: "report_unavailable" },
			},
		]);
	} finally {
		await h.close();
	}
});

test("a function that is not offered, or live information answered from hand, gets one repair; two in a row fail without publishing anything", async () => {
	const h = await setup();
	try {
		// Live information that is answered from hand is the host's structural contradiction.
		h.state.analyses.push({ kind: "live_info" }, {});
		h.state.main.push("お答えします。");
		const repaired = await h.ask("調べものです");
		expect(repaired.status).toBe("completed");
		expect(h.state.analysisCalls).toHaveLength(2);
		expect(
			h.state.analysisCalls[1]!.history.some((m) =>
				m.content.startsWith("UNTRUSTED_REJECTED_OUTPUT="),
			),
		).toBe(true);
		h.state.analyses.push({ kind: "live_info" }, { freshness: "live" });
		const run = await h.say("調べものです");
		const { bodies, stop } = bodiesOf(h, run.id);
		await h.finished(run.id);
		stop();
		expect(h.dialogue.get(run.id)?.status).toBe("failed");
		expect(bodies).toEqual([]);
		expect(h.dialogue.answerText(run.id)).toBeNull();
		expect(h.state.mainCalls).toHaveLength(1);
		expect(h.state.recorded.at(-1)).toMatchObject({ decision: "rejected" });
	} finally {
		await h.close();
	}
});

test("prose in the second round is not adopted: one repair, then failure, and no answer is generated from history", async () => {
	const h = await setup();
	try {
		h.state.analyses.push({ call: "studio_create", kind: "action" });
		h.startCall({ request: "何かを作る" });
		h.state.main.unshift("自然文で答えます。");
		h.state.specialist.push(reply("担当が答えます。"));
		const repaired = await h.ask("何かを作って");
		expect(repaired.status).toBe("completed");
		expect(h.state.mainCalls).toHaveLength(2);
		expect(
			h.state.mainCalls[1]!.history.some((m) =>
				m.content.startsWith("UNTRUSTED_REJECTED_OUTPUT="),
			),
		).toBe(true);
		expect(h.state.recorded.at(-1)).toMatchObject({
			decision: "toolchain",
			repaired: true,
		});
	} finally {
		await h.close();
	}
	// A session toolchain keeps the conversation after a hand-over: the failing case is a conversation of its own.
	const failing = await setup();
	try {
		const before = failing.state.mainCalls.length;
		failing.state.analyses.push({ call: "studio_create", kind: "action" });
		failing.state.main.push("自然文で答えます。", "また自然文です。");
		const run = await failing.say("何かを作って");
		const { bodies, stop } = bodiesOf(failing, run.id);
		await failing.finished(run.id);
		stop();
		expect(failing.dialogue.get(run.id)?.status).toBe("failed");
		expect(bodies).toEqual([]);
		expect(failing.dialogue.answerText(run.id)).toBeNull();
		// Both calls were of the chosen function: none of them was a history-carrying answer without functions.
		const calls = failing.state.mainCalls.slice(before);
		expect(calls).toHaveLength(2);
		expect(calls.every((call) => call.tools.length === 1)).toBe(true);
		expect(failing.state.specialistPrompts).toHaveLength(0);
		expect(failing.state.recorded.at(-1)).toMatchObject({
			decision: "rejected",
		});
	} finally {
		await failing.close();
	}
});

test("each message of the previous exchange is cut to the limit with the omission mark; shorter ones stay verbatim", () => {
	const turn = (role: "user" | "assistant", content: string) =>
		({ role, content }) as HistoryTurn;
	const long = "あ".repeat(PREVIOUS_MESSAGE_MAX_CHARS + 25);
	const [user, assistant] = previousExchange([
		turn("user", long),
		turn("assistant", "い".repeat(PREVIOUS_MESSAGE_MAX_CHARS)),
	]);
	expect(user!.content).toBe(
		"あ".repeat(PREVIOUS_MESSAGE_MAX_CHARS) + "（省略：約25文字）",
	);
	expect(assistant!.content).toBe("い".repeat(PREVIOUS_MESSAGE_MAX_CHARS));
	expect(previousExchange([turn("assistant", long)])[0]!.content).toBe(
		user!.content,
	);
});
