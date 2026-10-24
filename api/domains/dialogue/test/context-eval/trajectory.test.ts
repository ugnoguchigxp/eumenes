import { expect, test } from "bun:test";
import { messageIssues } from "../../eval/context/message-invariants";
import { promptHash } from "../../eval/context/prefix-stability";
import {
	DEFAULT_TRAJECTORY,
	SMALL_WINDOW_TRAJECTORY,
	type TrajectoryCall,
	playTrajectory,
} from "../../eval/context/trajectory";
import { openSeedWiring } from "./store-wiring";

async function play(trajectory: Parameters<typeof playTrajectory>[1]) {
	const wiring = await openSeedWiring();
	try {
		return await playTrajectory(wiring, trajectory);
	} finally {
		await wiring.close();
	}
}
type Doc = Record<string, any>;
const docOf = (call: TrajectoryCall): Doc =>
	JSON.parse(call.input.messages[1]!.content) as Doc;

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

test("between re-constructions the system part and the start of the document do not change: each call begins with the previous one up to the end of its log", async () => {
	const calls = await play(DEFAULT_TRAJECTORY);
	const system = calls[0]!.input.messages[0]!.content;
	for (const call of calls)
		expect(call.input.messages[0]!.content).toBe(system);
	for (let i = 1; i < calls.length; i++) {
		if (calls[i]!.reconstruction) continue;
		const previous = calls[i - 1]!.input.messages[1]!.content;
		const shared = previous.slice(0, previous.indexOf('],"active"'));
		expect(calls[i]!.input.messages[1]!.content.startsWith(shared)).toBe(true);
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

test("a memory saved after the profile was published waits in state.newMemories until a re-construction takes it into the profile", async () => {
	const calls = await play(DEFAULT_TRAJECTORY);
	const at = (n: number) => docOf(calls[n - 1]!);
	expect(at(3).state.newMemories).toEqual([]);
	expect(JSON.stringify(at(4).state.newMemories)).toContain("辛い物が好き");
	expect(at(4).profile).toEqual([]);
	expect(at(8).profile).toEqual([]);
	expect(JSON.stringify(at(9).profile)).toContain("辛い物が好き");
	expect(at(9).state.newMemories).toEqual([]);
});

test("the delegation opens a TODO, its finishing starts a generation with the fixed text, and the result is held in active", async () => {
	const calls = await play(DEFAULT_TRAJECTORY);
	const g5 = docOf(calls[4]!);
	expect(g5.state.todos).toEqual([]);
	const g6 = docOf(calls[5]!);
	expect(calls[5]!.input.final).toEqual({ kind: "fixed" });
	expect(g6.state.todos).toEqual([
		expect.objectContaining({
			title: "旅行先のイメージ画像を作る",
			status: "done",
		}),
	]);
	expect(g6.now.trigger).toEqual([
		{
			kind: "todo_changed",
			todos: [{ id: g6.state.todos[0].id, status: "done" }],
		},
	]);
	expect(JSON.stringify(g6.active)).toContain("京都の紅葉を描いた画像ができた");
	// The delegation the agent made is in the log with the TODO it opened.
	const acted = (docOf(calls[5]!).log as Array<Record<string, unknown>>).find(
		(e) => e.action === "delegate",
	);
	expect(acted).toMatchObject({ todo: g6.state.todos[0].id });
	// A notice starts a generation too, and the agent said nothing after it.
	expect(calls[7]!.input.final).toEqual({ kind: "fixed" });
	expect(docOf(calls[7]!).now.trigger).toEqual([
		{ kind: "timer", text: "三分のタイマーが鳴りました" },
	]);
});

test("in a small window the log passes its limit and the oldest events are moved out to the episode", async () => {
	const calls = await play(SMALL_WINDOW_TRAJECTORY);
	const reasons = calls.map((c) => c.reconstruction?.reason ?? null);
	expect(reasons).toContain("section_over_limit");
	const last = calls.at(-1)!;
	expect(last.input.plan.usable).toBe(true);
	const doc = docOf(last);
	// No summary was prepared, so what left the log is an unsummarized range.
	expect(doc.episode.length).toBeGreaterThan(0);
	expect(doc.episode[0]).toMatchObject({ kind: "unsummarized" });
	expect(last.input.document.sections.log.tokens).toBeLessThanOrEqual(
		last.input.plan.log.cap,
	);
	expect(JSON.stringify(doc.log)).not.toContain('"text":"1件目');
	expect(JSON.stringify(doc.log)).toContain("19件目の相談です");
	for (const call of calls) expect(messageIssues(call.input)).toEqual([]);
});
