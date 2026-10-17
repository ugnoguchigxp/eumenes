/**
 * The two-round start of a conversation (the design 2026-10-17): the first round analyzes the request from the
 * role, the exchange just before it and the request itself; the second answers it or hands it to a toolchain.
 */
import { afterEach, expect, test } from "bun:test";
import { configureLogging } from "../../../infrastructure/logger";
import { setup, type Harness } from "./specialist.fixture";
import type { RequestAnalysis } from "../service/initial-decision";
import {
	PREVIOUS_MESSAGE_MAX_CHARS,
	previousExchange,
} from "../service/request-analysis";
import type { HistoryTurn } from "../service/context-assembly";

afterEach(() => configureLogging({ level: "silent" }));

const reply = (text: string) => ({ action: "reply", text });
const unavailableCall = (text: string) => ({
	toolCalls: [
		{
			id: "u",
			name: "report_unavailable",
			arguments: JSON.stringify({ reply: text }),
		},
	],
});
const recordOf = (history: Array<{ content: string }>) => {
	const record = history.find((m) => m.content.startsWith("requestAnalysis"));
	return record
		? JSON.parse(record.content.slice(record.content.indexOf("=") + 1))
		: undefined;
};
const WEATHER: Partial<RequestAnalysis> & { goal: string } = {
	kind: "live_info",
	freshness: "live",
	next: "find_toolchain",
	goal: "鎌倉の今日の天気",
	deliverable: "根拠付きの調査結果",
	conditions: ["今日", "鎌倉"],
};
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

test("live information is analyzed, searched by its goal, announced and delegated", async () => {
	const events = capture();
	const h = await setup();
	try {
		h.state.analyses.push({ ...WEATHER, impact: "none" });
		h.startCall({
			request: "鎌倉の今日の天気",
			announcement: "お調べします。",
		});
		h.state.specialist.push(reply("担当が答えます。"));
		const run = await h.ask("今日の鎌倉の天気を教えて");
		expect(run.status).toBe("completed");
		expect(run.announcement).toBe("お調べします。");
		// The candidates were searched by the analysis' goal, not by the utterance.
		expect(h.state.routeTexts).toEqual([WEATHER.goal]);
		expect(h.state.analysisCalls).toHaveLength(1);
		// Selection offers the candidates and the explanation, and carries the analysis as a host record.
		const selection = h.state.mainCalls[0]!;
		expect(selection.tools.map((t) => t.function.name)).toEqual([
			"studio_create",
			"other_create",
			"report_unavailable",
		]);
		expect(recordOf(selection.history)).toEqual({
			goal: WEATHER.goal,
			deliverable: WEATHER.deliverable,
			conditions: WEATHER.conditions,
			missing: [],
		});
		expect(selection.history.at(-1)!.content).toBe("今日の鎌倉の天気を教えて");
		// The trace keeps the judgment, never the request.
		expect(h.state.recorded).toHaveLength(1);
		expect(h.state.recorded[0]).toMatchObject({
			decision: "toolchain",
			analysis: {
				kind: "live_info",
				freshness: "live",
				next: "find_toolchain",
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
			next: "find_toolchain",
		});
		// Not the impact, the approval or any other field of the judgment.
		expect(Object.keys(analyzed[0]!)).not.toContain("impact");
		expect(Object.keys(analyzed[0]!)).not.toContain("approved");
		expect(Object.keys(analyzed[0]!)).not.toContain("goal");
		expect(JSON.stringify(analyzed)).not.toContain("鎌倉");
	} finally {
		await h.close();
	}
});

test("an old answer to the same question, the memory and the time never reach the analysis", async () => {
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
		expect(h.state.routeTexts).toEqual([WEATHER.goal]);
		const input = h.state.analysisCalls[2]!.history;
		// The role, the exchange just before, the marker and the request: nothing else.
		expect(roles(h, 2)).toEqual([
			"system",
			"user",
			"assistant",
			"system",
			"user",
		]);
		expect(input.slice(1, 3).map((m) => m.content)).toEqual([
			"ありがとう",
			"どういたしまして。",
		]);
		const text = JSON.stringify(input);
		expect(text).not.toContain("22度");
		expect(text).not.toContain("以下は本人について");
		expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}/);
		expect(text).not.toContain("現在日時:");
	} finally {
		await h.close();
	}
});

test("a follow-up request is completed from the exchange just before it, and that goal is what is searched", async () => {
	const h = await setup();
	try {
		h.state.main.push("今日は晴れです。");
		await h.ask("鎌倉の天気は？");
		h.state.analyses.push({
			...WEATHER,
			goal: "鎌倉の明日の天気",
			conditions: ["明日"],
		});
		h.startCall({ request: "鎌倉の明日の天気" });
		h.state.specialist.push(reply("担当が答えます。"));
		const run = await h.ask("明日は？");
		expect(run.status).toBe("completed");
		expect(roles(h, 1)).toEqual([
			"system",
			"user",
			"assistant",
			"system",
			"user",
		]);
		expect(
			h.state.analysisCalls[1]!.history.map((m) => m.content).filter(Boolean),
		).toEqual(
			expect.arrayContaining([
				"鎌倉の天気は？",
				"今日は晴れです。",
				"明日は？",
			]),
		);
		expect(h.state.analysisCalls[1]!.history.at(-1)!.content).toBe("明日は？");
		expect(h.state.routeTexts).toEqual(["鎌倉の明日の天気"]);
	} finally {
		await h.close();
	}
});

test("general knowledge is answered in the second round with no search and no notice", async () => {
	const h = await setup();
	try {
		h.state.main.push("降水確率は雨の降る可能性です。");
		const run = await h.ask("降水確率って何？");
		expect(run.status).toBe("completed");
		expect(run.announcement).toBeNull();
		expect(h.state.routeCalls).toBe(0);
		expect(h.state.recorded).toMatchObject([
			{
				decision: "answer",
				retrieval: "none",
				candidates: [],
				analysis: { kind: "knowledge", next: "answer" },
			},
		]);
		expect(h.state.analysisCalls).toHaveLength(1);
		expect(h.state.mainCalls).toHaveLength(1);
		expect(h.state.mainCalls[0]!.tools).toEqual([]);
		expect(h.dialogue.answerText(run.id)).toBe(
			"降水確率は雨の降る可能性です。",
		);
	} finally {
		await h.close();
	}
});

test("a question is asked only when something is missing, and it is the answer round that asks", async () => {
	const h = await setup();
	try {
		h.state.analyses.push({
			kind: "knowledge",
			next: "clarify",
			missing: ["調べる場所"],
		});
		h.state.main.push("どちらの場所でしょうか。");
		const run = await h.ask("天気を教えて");
		expect(run.status).toBe("completed");
		expect(h.state.routeCalls).toBe(0);
		expect(recordOf(h.state.mainCalls[0]!.history)).toMatchObject({
			missing: ["調べる場所"],
		});
		expect(h.dialogue.answerText(run.id)).toBe("どちらの場所でしょうか。");
		// Without a missing item the judgment is refused.
		h.state.analyses.push({ next: "clarify" }, { next: "clarify" });
		const refused = await h.ask("天気を教えて");
		expect(refused.status).toBe("failed");
		expect(h.dialogue.answerText(refused.id)).toBeNull();
	} finally {
		await h.close();
	}
});

test("an inconsistent analysis gets one repair; two in a row fail without publishing anything", async () => {
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
		h.state.analyses.push({ kind: "live_info" }, { kind: "live_info" });
		const run = await h.say("調べものです");
		const bodies: string[] = [];
		const stop = h.dialogue.subscribeProgress(run.id, (p) => {
			if (p.text) bodies.push(p.text);
		});
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

test("prose in the selection round is not adopted: one repair, then failure, and no answer is generated from history", async () => {
	const h = await setup();
	try {
		h.state.analyses.push({ kind: "action", next: "find_toolchain" });
		h.state.main.push(
			"自然文で答えます。",
			unavailableCall("お任せできる担当がありません。"),
		);
		const repaired = await h.ask("何かを作って");
		expect(repaired.status).toBe("completed");
		expect(h.dialogue.answerText(repaired.id)).toBe(
			"お任せできる担当がありません。",
		);
		expect(h.state.mainCalls).toHaveLength(2);
		expect(
			h.state.mainCalls[1]!.history.some((m) =>
				m.content.startsWith("UNTRUSTED_REJECTED_OUTPUT="),
			),
		).toBe(true);
		const before = h.state.mainCalls.length;
		h.state.analyses.push({ kind: "action", next: "find_toolchain" });
		h.state.main.push("自然文で答えます。", "また自然文です。");
		const run = await h.say("何かを作って");
		const bodies: string[] = [];
		const stop = h.dialogue.subscribeProgress(run.id, (p) => {
			if (p.text) bodies.push(p.text);
		});
		await h.finished(run.id);
		stop();
		expect(h.dialogue.get(run.id)?.status).toBe("failed");
		expect(bodies).toEqual([]);
		expect(h.dialogue.answerText(run.id)).toBeNull();
		// Both calls were selections: none of them was a history-carrying answer without functions.
		const calls = h.state.mainCalls.slice(before);
		expect(calls).toHaveLength(2);
		expect(calls.every((call) => call.tools.length > 0)).toBe(true);
		expect(h.state.recorded.at(-1)).toMatchObject({ decision: "rejected" });
	} finally {
		await h.close();
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
