import { expect, test } from "bun:test";
import { baselineAaArm, baselineArm } from "../../eval/context/arm";
import { orderingVariant } from "../../eval/context/ordering";
import {
	measurePrefix,
	prefixReportSchema,
} from "../../eval/context/prefix-measure";
import {
	DEFAULT_TRAJECTORY,
	materializeTrajectory,
} from "../../eval/context/trajectory";
import { arms as exampleArms } from "../../../../../scripts/context-eval/experiments/2026-10-17-source-format/arms";
import { openSeedWiring } from "./store-wiring";

const a2 = exampleArms.find((a) => a.id === "A2")!;
const measured = [
	baselineArm,
	baselineAaArm,
	orderingVariant(baselineArm, "A0-o2", "O2"),
	a2,
	orderingVariant(a2, "A2-o2", "O2"),
];

test("the trajectory is ten turns with a memory step, an operation result, research success and failure, and a selection call", async () => {
	const wiring = await openSeedWiring();
	let calls: Awaited<ReturnType<typeof materializeTrajectory>>;
	try {
		calls = await materializeTrajectory(wiring);
	} finally {
		await wiring.close();
	}
	expect(DEFAULT_TRAJECTORY.turns.length).toBeGreaterThanOrEqual(10);
	expect(new Set(calls.map((c) => c.turn)).size).toBe(
		DEFAULT_TRAJECTORY.turns.length,
	);
	expect(new Set(calls.map((c) => c.kind))).toEqual(
		new Set(["initial", "selection", "result"]),
	);
	const sources = new Set(
		calls.flatMap((c) => [
			...c.assembly.stable.map((b) => b.source),
			...c.assembly.working.map((b) => b.source),
			...c.assembly.volatile.map((b) => b.source),
		]),
	);
	for (const source of [
		"goals",
		"memory.long_term",
		"memory.summary",
		"memory.notice",
		"memory.recall",
		"world.names",
		"operation.image",
		"operation.recognition",
		"research.result",
	] as const)
		expect(sources.has(source)).toBe(true);
	expect(calls.some((c) => c.assembly.stage === "selection")).toBe(true);
	// The history grows turn by turn, and the memory steps change what is verbatim.
	const history = (turn: number) =>
		calls.find((c) => c.turn === turn)!.assembly.history.turns;
	expect(history(1)).toHaveLength(0);
	expect(history(3).length).toBeGreaterThan(history(2).length);
	expect(history(7).some((t) => t.content.includes("紅葉"))).toBe(false);
	// Every call has the current turn's input last.
	for (const c of calls)
		expect(c.assembly.input.content).toBe(
			DEFAULT_TRAJECTORY.turns[c.turn - 1]!.user,
		);
}, 30_000);

test("prefix stability: deterministic, per call bytes and tokens, the A/A control equals the baseline, O2 differs from O1", async () => {
	const first = await measurePrefix({
		arms: measured,
		serialization: "larm-messages",
		openWiring: openSeedWiring,
	});
	const second = await measurePrefix({
		arms: measured,
		serialization: "larm-messages",
		openWiring: openSeedWiring,
	});
	expect(second).toEqual(first);
	expect(prefixReportSchema.parse(first)).toEqual(first);
	const a0 = first.arms.A0!;
	expect(a0.calls.length).toBeGreaterThanOrEqual(10);
	expect(a0.calls[0]!.sharedBytes).toBeNull();
	for (const call of a0.calls.slice(1)) {
		expect(call.sharedBytes).toBeGreaterThan(0);
		expect(call.sharedTokens).toBeGreaterThan(0);
		expect(call.tokenRatio).toBeLessThanOrEqual(1);
	}
	expect(a0.medianRatio).toBeGreaterThan(0.5);
	expect(first.arms["A0-aa"]).toEqual(a0);
	// Moving the working memory behind the history changes which later calls share it.
	const shared = (id: string) =>
		first.arms[id]!.calls.map((c) => c.sharedTokens);
	expect(shared("A0-o2")).not.toEqual(shared("A0"));
	expect(shared("A2-o2")).not.toEqual(shared("A2"));
	// The candidate has a longer system part, so more tokens per call.
	expect(first.arms.A2!.calls[0]!.tokens).toBeGreaterThan(a0.calls[0]!.tokens);
}, 60_000);

test("the flattened lane measures the same trajectory through promptParts", async () => {
	const flat = await measurePrefix({
		arms: measured,
		serialization: "flattened",
		openWiring: openSeedWiring,
	});
	expect(flat.serialization).toBe("flattened");
	// promptParts splits the history off by the session split whatever the order, so O2 changes nothing there.
	expect(flat.arms["A0-o2"]!.calls.map((c) => c.promptSha256)).toEqual(
		flat.arms.A0!.calls.map((c) => c.promptSha256),
	);
}, 60_000);
