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

/** The last message of a generation: `## State`, then `## Host notice` or `## User`. */
const lastOf = (call: TrajectoryCall): string =>
	call.input.messages.at(-1)!.content;
/** The lines of one `## ` section of a generation's last message. */
const sectionOf = (call: TrajectoryCall, heading: string): string[] =>
	sectionLines(lastOf(call), heading);
/** The `## Memory` lines a generation shows (its own message, or the head of the last one). */
const memoryOf = (call: TrajectoryCall): string[] =>
	call.input.messages.flatMap((m) => sectionLines(m.content, "Memory"));

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

test("between cuts the input only grows at its end: each call begins with the previous one but its last message", async () => {
	const calls = await play(DEFAULT_TRAJECTORY);
	const system = calls[0]!.input.messages[0]!.content;
	for (const call of calls)
		expect(call.input.messages[0]!.content).toBe(system);
	for (let i = 1; i < calls.length; i++) {
		if (calls[i]!.cut) continue;
		const previous = calls[i - 1]!.input.messages.slice(0, -1);
		const current = calls[i]!.input.messages;
		// Every message but the newest stays as it was; the newest may only grow (the agent spoke on after it).
		expect(current.slice(0, previous.length - 1)).toEqual(
			previous.slice(0, -1),
		);
		const was = previous.at(-1)!;
		const now = current[previous.length - 1]!;
		expect(now.role).toBe(was.role);
		expect(now.content.startsWith(was.content)).toBe(true);
	}
});

test("the recent conversation is cut where the host's rules say: a long silence resumes the conversation", async () => {
	const calls = await play(DEFAULT_TRAJECTORY);
	expect(calls.map((c, i) => [`g${i + 1}`, c.cut?.reason ?? null])).toEqual(
		calls.map((_, i) => [`g${i + 1}`, i === 8 ? "resumed" : null]),
	);
	// The gap is said in the state, once.
	expect(sectionOf(calls[8]!, "State")[0]).toMatch(/（前の発言から37分）$/);
	expect(sectionOf(calls[9]!, "State")[0]).not.toContain("前の発言から");
});

test("a memory saved after the profile was drawn waits until a cut draws `## Memory` again", async () => {
	const calls = await play(DEFAULT_TRAJECTORY);
	for (const n of [3, 4, 5, 6, 7, 8])
		expect(memoryOf(calls[n - 1]!).join("\n")).not.toContain("辛い物が好き");
	expect(memoryOf(calls[8]!).join("\n")).toContain("辛い物が好き");
});

test("the delegation's TODO is a line of the state, and a notice is the host notice of its generation", async () => {
	const calls = await play(DEFAULT_TRAJECTORY);
	const todos = (call: TrajectoryCall) =>
		sectionOf(call, "State").filter((line) => /^- t\d+ /.test(line));
	expect(todos(calls[4]!)).toEqual([]);
	expect(calls[5]!.input.final).toEqual({ kind: "fixed" });
	expect(todos(calls[5]!)).toEqual([
		"- t1 旅行先のイメージ画像を作る 完了 未報告",
	]);
	expect(calls[7]!.input.final).toEqual({ kind: "fixed" });
	expect(sectionOf(calls[7]!, "Host notice")).toEqual([
		"- kind: timer",
		"- text: 三分のタイマーが鳴りました",
	]);
	// The tool exchanges of the delegation stayed in their turn.
	for (const call of calls)
		expect(call.input.messages.some((m) => m.role === "tool")).toBe(false);
});

test("long exchanges pass the hard limit and the host cuts the recent conversation to the newest few", async () => {
	const calls = await play(SMALL_WINDOW_TRAJECTORY);
	const reasons = calls.map((c) => c.cut?.reason ?? null);
	expect(reasons).toContain("over_limit");
	const at = reasons.indexOf("over_limit");
	expect(calls[at]!.input.messages.length).toBeLessThan(
		calls[at - 1]!.input.messages.length,
	);
	const last = calls
		.at(-1)!
		.input.messages.map((m) => m.content)
		.join("\n");
	expect(last).not.toMatch(/(^|\n)1件目の相談/);
	expect(last).toContain("19件目の相談");
	for (const call of calls) expect(messageIssues(call.input)).toEqual([]);
});
