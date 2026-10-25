import { expect, test } from "bun:test";
import { messageIssues } from "../../eval/context/message-invariants";
import { promptHash } from "../../eval/context/prefix-stability";
import {
	DEFAULT_TRAJECTORY,
	SMALL_WINDOW_TRAJECTORY,
	type TrajectoryCall,
	playTrajectory,
} from "../../eval/context/trajectory";
import { sectionLines } from "../generation.fixture";
import { openSeedWiring } from "./store-wiring";

async function play(trajectory: Parameters<typeof playTrajectory>[1]) {
	const wiring = await openSeedWiring();
	try {
		return await playTrajectory(wiring, trajectory);
	} finally {
		await wiring.close();
	}
}

/** The material document (the second message) of a generation. */
const documentOf = (call: TrajectoryCall): string =>
	call.input.messages[1]!.content;
/** The lines of one tagged section of a generation's document. */
const sectionOf = (call: TrajectoryCall, name: string): string[] =>
	sectionLines(documentOf(call), name);
/** The lines of the `<now>` block (the third message) of a generation. */
const nowOf = (call: TrajectoryCall): string[] =>
	sectionLines(call.input.messages[2]!.content, "now");
/** The `<memory>` lines a generation's document shows. */
const memoryOf = (call: TrajectoryCall): string[] => sectionOf(call, "memory");

test("the default trajectory is twelve generations that keep the message invariants", async () => {
	const calls = await play(DEFAULT_TRAJECTORY);
	expect(calls.map((c) => c.label)).toEqual(
		Array.from({ length: 12 }, (_, i) => `g${i + 1}`),
	);
	for (const call of calls) expect(messageIssues(call.input)).toEqual([]);
	// The same code gives the same messages.
	const again = await play(DEFAULT_TRAJECTORY);
	expect(again.map((c) => promptHash(c.input.messages))).toEqual(
		calls.map((c) => promptHash(c.input.messages)),
	);
});

test("between re-constructions the system part and the start of the document do not change: each call begins with the previous one up to its state section", async () => {
	const calls = await play(DEFAULT_TRAJECTORY);
	const system = calls[0]!.input.messages[0]!.content;
	for (const call of calls)
		expect(call.input.messages[0]!.content).toBe(system);
	for (let i = 1; i < calls.length; i++) {
		if (calls[i]!.reconstruction) continue;
		// The shared prefix is the document up to the end of its log, just before `</log>` (the layout specification,
		// section 12): the memory, history and log of the previous call, which only grow at their end (an empty
		// section is its two tags alone, so even the first event only appends).
		const previous = documentOf(calls[i - 1]!);
		const shared = previous.slice(0, previous.indexOf("</log>"));
		expect(documentOf(calls[i]!).startsWith(shared)).toBe(true);
	}
});

test("the window is re-constructed where the product's rules say: a long silence resumes the conversation, an idle cache is taken as lost", async () => {
	const calls = await play(DEFAULT_TRAJECTORY);
	expect(
		calls.map((c, i) => [`g${i + 1}`, c.reconstruction?.reason ?? null]),
	).toEqual([
		["g1", null],
		["g2", null],
		["g3", null],
		["g4", null],
		["g5", null],
		["g6", null],
		["g7", null],
		["g8", null],
		["g9", "resumed"],
		["g10", null],
		["g11", "cache_lost"],
		["g12", null],
	]);
});

test("a memory saved after the profile was published waits in <state> (n-lines) until a re-construction takes it into <memory>", async () => {
	const calls = await play(DEFAULT_TRAJECTORY);
	const waiting = (n: number) =>
		sectionOf(calls[n - 1]!, "state").filter((line) =>
			/^n\d+ 反映待ちの記憶 /.test(line),
		);
	expect(waiting(3)).toEqual([]);
	expect(waiting(4).join("\n")).toContain("辛い物が好き");
	expect(memoryOf(calls[3]!)).toEqual([]);
	expect(memoryOf(calls[7]!)).toEqual([]);
	expect(memoryOf(calls[8]!).join("\n")).toContain("辛い物が好き");
	expect(waiting(9)).toEqual([]);
});

test("the delegation opens a TODO, its finishing starts a generation with the fixed text, and the result is a line of the log", async () => {
	const calls = await play(DEFAULT_TRAJECTORY);
	const todos = (call: TrajectoryCall) =>
		sectionOf(call, "state").filter((line) => /^t\d+ /.test(line));
	expect(todos(calls[4]!)).toEqual([]);
	expect(calls[5]!.input.final).toEqual({ kind: "fixed" });
	expect(todos(calls[5]!)).toEqual([
		expect.stringMatching(/^t1 完了 旅行先のイメージ画像を作る \(/),
	]);
	expect(nowOf(calls[5]!)).toContain("きっかけ 仕事の変化 t1 完了");
	// The result is a log line of its own (the layout specification, section 4.3), not a slot of the state.
	expect(
		sectionOf(calls[5]!, "log").some(
			(line) =>
				/結果 t1 成功: /.test(line) &&
				line.includes("京都の紅葉を描いた画像ができた"),
		),
	).toBe(true);
	// The delegation the agent made is in the log with the TODO it opened.
	expect(
		sectionOf(calls[5]!, "log").some((line) => /依頼 t1 /.test(line)),
	).toBe(true);
	// A notice starts a generation too, and the agent said nothing after it.
	expect(calls[7]!.input.final).toEqual({ kind: "fixed" });
	expect(nowOf(calls[7]!)).toContain(
		'きっかけ timer {"text":"三分のタイマーが鳴りました"}',
	);
});

test("in a small window the log passes its limit and the oldest events are moved out to the history", async () => {
	const calls = await play(SMALL_WINDOW_TRAJECTORY);
	const reasons = calls.map((c) => c.reconstruction?.reason ?? null);
	expect(reasons).toContain("section_over_limit");
	const last = calls.at(-1)!;
	expect(last.input.plan.usable).toBe(true);
	// No summary was prepared, so what left the log is an unsummarized range (`s<n>` without a summary).
	expect(
		sectionOf(last, "history").some((line) =>
			/^s\d+ \d{2}-\d{2}〜\d{2}-\d{2} 要約なし/.test(line),
		),
	).toBe(true);
	expect(last.input.document.sections.log.tokens).toBeLessThanOrEqual(
		last.input.plan.log.cap,
	);
	const log = sectionOf(last, "log");
	expect(log.some((line) => /: 1件目/.test(line))).toBe(false);
	expect(log.some((line) => line.includes("19件目の相談です"))).toBe(true);
	for (const call of calls) expect(messageIssues(call.input)).toEqual([]);
});
