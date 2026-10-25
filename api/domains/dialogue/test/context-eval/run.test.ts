import { expect, test } from "bun:test";
import { loadCases } from "../../eval/context/case-loader";
import { createFixtureRunner } from "../../eval/context/fixture-lane";
import {
	COMPARED_TRAJECTORY,
	measurePrefix,
	prefixReportSchema,
} from "../../eval/context/prefix-measure";
import { prefixStability } from "../../eval/context/prefix-stability";
import type { RawRow } from "../../eval/context/raw";
import { executeRun, planJobs } from "../../eval/context/run";
import { makeCase } from "./case-fixtures";
import { openSeedWiring } from "./store-wiring";

const cases = [
	makeCase("ctx-f9-dev-01", "こんにちは"),
	makeCase("ctx-f9-dev-02", "今日はいい天気ですね"),
];
const base = { cases, trials: 3, openWiring: openSeedWiring, catalog: [] };

test("every case is prepared once by the production code and its trials share the messages", async () => {
	const jobs = await planJobs(base);
	expect(jobs.map((j) => `${j.caseId}:${j.trial}`)).toEqual([
		"ctx-f9-dev-01:1",
		"ctx-f9-dev-01:2",
		"ctx-f9-dev-01:3",
		"ctx-f9-dev-02:1",
		"ctx-f9-dev-02:2",
		"ctx-f9-dev-02:3",
	]);
	expect(jobs[0]!.input).toBe(jobs[2]!.input);
	expect(jobs[0]!.input).not.toBe(jobs[3]!.input);
	const only = await planJobs({
		...base,
		only: (c) => c.caseId === "ctx-f9-dev-02" && c.trial === 2,
	});
	expect(only.map((j) => j.order)).toEqual([4]);
});

test("planJobs closes every store it opens, including when a case cannot be prepared", async () => {
	let opened = 0;
	let closed = 0;
	const openWiring = async () => {
		opened++;
		const w = await openSeedWiring();
		return {
			...w,
			close: async () => {
				closed++;
				await w.close();
			},
		};
	};
	await planJobs({ ...base, openWiring });
	expect([opened, closed]).toEqual([2, 2]);
	opened = closed = 0;
	await expect(
		planJobs({
			...base,
			openWiring,
			cases: [makeCase("ctx-f9-dev-01", "あ", { seed: { modelWindow: 2000 } })],
		}),
	).rejects.toThrow("window_too_small");
	expect([opened, closed]).toEqual([1, 1]);
});

test("a run records one row per call; a thrown error is a transport error with its class only, a contract failure is its own status", async () => {
	const rows: RawRow[] = [];
	const fixture = createFixtureRunner(cases);
	await executeRun({
		...base,
		lane: "fixture",
		concurrency: 5,
		runner: async (call, signal) => {
			if (call.caseId === "ctx-f9-dev-01" && call.trial === 1)
				throw new TypeError("secret provider text");
			if (call.caseId === "ctx-f9-dev-01" && call.trial === 2)
				return { kind: "contract_failure", code: "x" };
			return fixture(call, signal);
		},
		onRow: (row) => rows.push(row),
	});
	expect(rows).toHaveLength(6);
	const by = (caseId: string, trial: number) =>
		rows.find((r) => r.caseId === caseId && r.trial === trial)!;
	expect(by("ctx-f9-dev-01", 1)).toMatchObject({
		status: "transport_error",
		errorCode: "TypeError",
	});
	expect(JSON.stringify(by("ctx-f9-dev-01", 1))).not.toContain("secret");
	expect(by("ctx-f9-dev-01", 2)).toMatchObject({
		status: "contract_failure",
		errorCode: "x",
	});
	expect(by("ctx-f9-dev-01", 3)).toMatchObject({
		status: "ok",
		answer: { text: "承知しました。" },
		messageCount: 3,
	});
	expect(by("ctx-f9-dev-01", 3).promptTokensEstimate).toBeGreaterThan(0);
	// The trials of one case send the same prompt.
	expect(by("ctx-f9-dev-01", 3).promptSha256).toBe(
		by("ctx-f9-dev-01", 2).promptSha256,
	);
	expect(by("ctx-f9-dev-02", 1).promptSha256).not.toBe(
		by("ctx-f9-dev-01", 1).promptSha256,
	);
});

test("the fixture model answers through the production loop, so tools, analysis and delegation are exercised", async () => {
	const delegating = makeCase("ctx-f13-dev-01", "天気を調べて", {
		expect: {
			checks: [{ kind: "delegated", toolchain: "web_research" }],
			rubric: [{ axis: "capability_judgment", condition: "x" }],
		},
	});
	const catalog = [
		{
			id: "web_research",
			title: "Web調査",
			summary: "公開Webを調べる",
			useWhen: ["天気を調べる"],
		},
	];
	const rows: RawRow[] = [];
	await executeRun({
		cases: [delegating],
		trials: 1,
		concurrency: 1,
		openWiring: openSeedWiring,
		catalog,
		lane: "fixture",
		runner: createFixtureRunner([delegating], catalog),
		onRow: (row) => rows.push(row),
	});
	expect(rows[0]).toMatchObject({ status: "ok" });
	expect(rows[0]!.answer!.toolCalls.map((c) => c.name)).toEqual([
		"find_toolchain",
		"delegate",
	]);
});

test("the trajectory measurement is a valid report; ordinary calls share nearly all of the previous prompt, re-constructed ones less", async () => {
	const report = await measurePrefix({ openWiring: openSeedWiring });
	expect(prefixReportSchema.safeParse(report).success).toBe(true);
	expect(Object.keys(report.trajectories).sort()).toEqual([
		"default",
		"smallWindow",
	]);
	const compared = report.trajectories[COMPARED_TRAJECTORY]!;
	expect(compared.calls).toHaveLength(12);
	expect(compared.medianRatio).toBeGreaterThan(0.9);
	const rebuilt = compared.calls.filter((c) => c.reconstruction !== null);
	expect(rebuilt.map((c) => c.label)).toEqual(["g9", "g11"]);
	// A re-construction rewrites part of the document (here the profile takes in the waiting memory).
	for (const call of rebuilt) expect(call.tokenRatio!).toBeLessThan(1);
	expect(
		report.trajectories.smallWindow!.calls.some(
			(c) => c.reconstruction === "section_over_limit",
		),
	).toBe(true);
});

test("prefix stability counts the shared bytes of consecutive calls", () => {
	const m = (content: string) => [{ role: "user" as const, content }];
	const stability = prefixStability([m("abcdef"), m("abcxyz"), m("abcxyz!")]);
	expect(stability.pairs.map((p) => p.sharedBytes)).toBeDefined();
	expect(stability.pairs[1]!.ratio).toBeGreaterThan(stability.pairs[0]!.ratio);
	expect(stability.medianRatio).not.toBeNull();
	expect(prefixStability([m("a")]).medianRatio).toBeNull();
});

test("the example experiment's cases all prepare within the message invariants", async () => {
	const dir = new URL(
		"../../../../../scripts/context-eval/experiments/2026-10-24-context-window",
		import.meta.url,
	).pathname;
	const jobs = await planJobs({
		cases: loadCases(dir),
		trials: 1,
		openWiring: openSeedWiring,
		catalog: [],
	});
	expect(jobs.length).toBe(loadCases(dir).length);
});
