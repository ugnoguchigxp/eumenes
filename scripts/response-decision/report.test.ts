import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configureLogging, getLogger } from "../../api/infrastructure/logger";
import {
	callReport,
	cacheAcceptance,
	readEvents,
	latencyStats,
} from "./report";

const row = { subjectId: "a", outcome: "ok", role: "main", correct: true };
const events = [
	{
		subjectId: "a",
		event: "larm.token_count_completed",
		promptTokens: 14000,
		bootEpoch: "epoch-test",
		configRevision: "rev-test",
	},
	{
		subjectId: "a",
		event: "larm.llm_timing",
		outcome: "ok",
		providerCachedTokens: 13996,
	},
];

test("latency summaries use the central pair for even samples and nearest-rank p95", () => {
	const values = [100, 1];
	expect(latencyStats(values)).toEqual({
		medianMs: 50.5,
		p95Ms: 100,
		maxMs: 100,
	});
	expect(values).toEqual([100, 1]);
	expect(latencyStats([30, 10, 20]).medianMs).toBe(20);
	expect(latencyStats(Array.from({ length: 20 }, (_, i) => i + 1)).p95Ms).toBe(
		19,
	);
	expect(latencyStats([])).toEqual({
		medianMs: null,
		p95Ms: null,
		maxMs: null,
	});
});
test("report refuses missing, duplicate and mixed-revision metrics rather than accepting partial timings", () => {
	expect(callReport(events, [row]).revisionComparable).toBe(true);
	for (const broken of [
		events.slice(0, 1),
		[...events, events[1]!],
		[events[1]!],
		[{ ...events[0], bootEpoch: undefined }, events[1]!],
	])
		expect(callReport(broken, [row]).revisionComparable).toBe(false);
	const two = [
		...events,
		...events.map((e) => ({ ...e, subjectId: "b", bootEpoch: "epoch-new" })),
	];
	expect(
		callReport(two, [row, { ...row, subjectId: "b" }]).revisionComparable,
	).toBe(false);
});
test("cache acceptance refuses successful but invisible or undersized product input", () => {
	expect(
		cacheAcceptance(callReport(events, [{ ...row, correct: false }])).passed,
	).toBe(false);
	expect(
		cacheAcceptance(
			callReport([{ ...events[0], promptTokens: 2682 }, events[1]!], [row]),
		).passed,
	).toBe(false);
	expect(
		cacheAcceptance(callReport(events, [{ ...row, outcome: "error" }])).passed,
	).toBe(false);
});
test("one measurement cannot be counted twice through duplicate subject rows", () => {
	expect(callReport(events, [row, row]).revisionComparable).toBe(false);
});
test("successful rows cannot conceal an error in their timing event", () => {
	expect(
		callReport([events[0]!, { ...events[1], outcome: "error" }], [row])
			.revisionComparable,
	).toBe(false);
});
test("unattributed and orphan measurements cannot disappear from coverage", () => {
	for (const subjectId of ["orphan", undefined]) {
		expect(
			callReport([...events, { ...events[1], subjectId }], [row])
				.revisionComparable,
		).toBe(false);
	}
});
test("cache acceptance requires the full scenario and actual retained tokens", () => {
	const phases = [
		"first_seen",
		"immediate_repeat",
		"same_system_different_user",
		"background_updated",
		"original_repeat",
		"auxiliary_1",
		"auxiliary_2",
		"auxiliary_3",
		"auxiliary_4",
		"after_four_auxiliary",
	];
	const rows = phases.map((phase) => ({
		...row,
		phase,
		subjectId: phase,
		role: phase.startsWith("auxiliary") ? "auxiliary" : "main",
	}));
	const all = phases.flatMap((phase) =>
		events.map((e) => ({ ...e, subjectId: phase })),
	);
	expect(cacheAcceptance(callReport(all, rows)).passed).toBe(true);
	expect(cacheAcceptance(callReport(all, [...rows, rows[0]!])).passed).toBe(
		false,
	);
	expect(
		cacheAcceptance(
			callReport(all, [rows[0]!, rows.at(-1)!, ...rows.slice(1, -1)]),
		).passed,
	).toBe(false);
	expect(
		cacheAcceptance(callReport(all.slice(0, -2), rows.slice(0, -1))).passed,
	).toBe(false);
	expect(
		cacheAcceptance(
			callReport(
				all.map((e) => ({ ...e, providerCachedTokens: 0 })),
				rows,
			),
		).retained,
	).toBe(false);
});
test("reading a runner log flushes its final buffered event immediately", () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-report-")),
		path = join(dir, "log.jsonl");
	try {
		configureLogging({
			file: path,
			level: "info",
			destination: { write() {} },
		});
		getLogger("larm").info("larm.llm_timing", {
			subjectId: "last",
			outcome: "ok",
		});
		expect(readFileSync(path, "utf8")).toBe("");
		expect(readEvents(path).at(-1)).toMatchObject({ subjectId: "last" });
	} finally {
		configureLogging({ level: "silent" });
		rmSync(dir, { recursive: true, force: true });
	}
});
