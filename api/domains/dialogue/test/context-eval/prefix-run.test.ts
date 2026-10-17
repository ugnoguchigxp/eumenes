import { expect, test } from "bun:test";
import { baselineAaArm, baselineArm } from "../../eval/context/arm";
import {
	canonicalJson,
	commonPrefixBytes,
	median,
	prefixStability,
} from "../../eval/context/prefix-stability";
import { type Materialized, materialize } from "../../eval/context/materialize";
import { renderContext } from "../../service/context-render";
import { executeRun, planJobs, williamsOrders } from "../../eval/context/run";
import { makeCase } from "./case-fixtures";
import { openSeedWiring } from "./store-wiring";

const msg = (role: "system" | "user" | "assistant", content: string) => ({
	role,
	content,
});

test("canonical JSON ignores key order and drops undefined", () => {
	expect(
		canonicalJson({ b: 1, a: { d: [2, { z: 1, y: undefined }], c: null } }),
	).toBe('{"a":{"c":null,"d":[2,{"z":1}]},"b":1}');
});

test("shared prefix bytes between consecutive calls of one conversation", () => {
	expect(commonPrefixBytes(Buffer.from("abcd"), Buffer.from("abXd"))).toBe(2);
	const system = msg("system", "規則");
	const first = [system, msg("user", "一つ目")];
	const second = [
		system,
		msg("user", "一つ目"),
		msg("assistant", "答え"),
		msg("user", "二つ目"),
	];
	const third = [msg("system", "規則が変わった"), ...second.slice(1)];
	const result = prefixStability([first, second, third]);
	expect(result.pairs).toHaveLength(2);
	// Everything the first call sent is the head of the second call.
	expect(result.pairs[0]).toMatchObject({
		from: 0,
		ratio: 1,
		sharedBytes: result.pairs[0]!.previousBytes,
	});
	// A changed system message ruins the prefix almost entirely.
	expect(result.pairs[1]!.ratio).toBeLessThan(0.2);
	expect(result.medianRatio).toBeCloseTo((1 + result.pairs[1]!.ratio) / 2);
	expect(prefixStability([first]).medianRatio).toBeNull();
	expect(median([])).toBeNull();
});

test("Williams orders balance which arm follows which", () => {
	expect(williamsOrders(1)).toEqual([[0]]);
	expect(williamsOrders(2)).toEqual([
		[0, 1],
		[1, 0],
	]);
	for (const n of [3, 4, 5, 6]) {
		const rows = williamsOrders(n);
		expect(rows).toHaveLength(n % 2 ? 2 * n : n);
		const follows = new Map<string, number>();
		const position = Array.from({ length: n }, () =>
			Array.from({ length: n }, () => 0),
		);
		for (const row of rows) {
			expect([...row].sort()).toEqual(Array.from({ length: n }, (_, i) => i));
			row.forEach((arm, i) => {
				position[arm]![i] = position[arm]![i]! + 1;
			});
			for (let i = 0; i + 1 < row.length; i++)
				follows.set(
					`${row[i]}>${row[i + 1]}`,
					(follows.get(`${row[i]}>${row[i + 1]}`) ?? 0) + 1,
				);
		}
		// Every ordered pair of different arms follows each other equally often.
		expect(new Set(follows.values()).size).toBe(1);
		expect(follows.size).toBe(n * (n - 1));
		for (const counts of position) expect(new Set(counts).size).toBe(1);
	}
});

const cases = [
	makeCase("ctx-f1-dev-01", "旅行の行き先を確認させて"),
	makeCase("ctx-f9-dev-01", "こんにちは。今日の調子はどう？"),
];
const arms = [baselineArm, baselineAaArm];

test("the run plan orders arms per Williams, trial by trial, and builds every arm from one materialization", async () => {
	const jobs = await planJobs({
		cases,
		arms,
		trials: 3,
		serialization: "larm-messages",
		openWiring: openSeedWiring,
	});
	expect(jobs).toHaveLength(2 * 2 * 3);
	const firstArm = jobs.filter((_, i) => i % 2 === 0).map((j) => j.arm.id);
	expect(new Set(firstArm).size).toBe(2);
	for (const job of jobs) expect(job.messages.at(-1)!.role).toBe("user");
});

test("a run records one row per call; a failing call is a transport_error row and the run goes on; concurrency never exceeds 2", async () => {
	const rows: string[] = [];
	let active = 0;
	let peak = 0;
	const result = await executeRun({
		lane: "fixture",
		serialization: "larm-messages",
		cases,
		arms,
		trials: 3,
		concurrency: 8,
		openWiring: openSeedWiring,
		runner: async (call) => {
			active++;
			peak = Math.max(peak, active);
			await new Promise((r) => setTimeout(r, 2));
			active--;
			if (
				call.caseId === "ctx-f9-dev-01" &&
				call.trial === 2 &&
				call.arm === "A0"
			)
				throw new TypeError("network down");
			if (call.trial === 3 && call.arm === "A0-aa")
				return {
					kind: "contract_failure",
					code: "invalid_conversation_operation",
					repaired: true,
				};
			return { kind: "ok", text: "はい。", toolCalls: [], repaired: false };
		},
		onRow: (row) =>
			rows.push(
				`${row.arm}|${row.caseId}|${row.trial}|${row.status}|${row.errorCode ?? ""}`,
			),
	});
	expect(result.jobs).toBe(12);
	expect(rows).toHaveLength(12);
	expect(rows).toContain("A0|ctx-f9-dev-01|2|transport_error|TypeError");
	expect(rows.filter((r) => r.includes("contract_failure"))).toHaveLength(2);
	expect(peak).toBeLessThanOrEqual(2);
});

test("the baseline arm is the product's own current render of the assembly, deterministic across materializations", async () => {
	const seeded = makeCase("ctx-f8-dev-01", "メモは保存できた？", {
		seed: {
			notices: ["メモの保存に失敗しました"],
			world: [{ name: "音声サービス" }],
		},
		expect: { checks: [{ kind: "brief_spoken_reply" }], rubric: [] },
	});
	const build = async () => {
		const m: Materialized = await materialize(seeded, await openSeedWiring());
		try {
			return {
				arm: baselineArm.build(m.assembly),
				product: renderContext(m.assembly, "current"),
			};
		} finally {
			await m.close();
		}
	};
	const a = await build();
	expect(a.arm.messages).toEqual(a.product.messages);
	expect(a.arm.sessionContext).toEqual(a.product.sessionContext);
	expect(a.arm.currentRequestIndex).toBe(a.product.currentRequestIndex);
	expect(JSON.stringify(a.arm.messages)).toBe(
		JSON.stringify((await build()).arm.messages),
	);
	const texts = a.arm.messages.map((m) => m.content);
	expect(texts.at(-1)).toBe("メモは保存できた？");
	expect(texts.at(-2)).toContain("音声サービス");
	expect(texts.at(-3)).toContain("記憶の担当からの連絡です");
});
