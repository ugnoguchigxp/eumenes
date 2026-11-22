import { expect, test } from "bun:test";
import { encodeSections } from "../api/domains/inference/service/input-sections";
import type { LogEntry } from "../api/infrastructure/log-reader";
import {
	conversationPerformance,
	readCodexUsage,
} from "./conversation-performance";

const start = Date.parse("2026-11-21T08:17:49+09:00");
const end = start + 10_000;
const instant = (offset: number) => new Date(start + offset).toISOString();
const event = (at: number, name: string, fields: LogEntry) => ({
	time: instant(at),
	event: name,
	...fields,
});
const usage = (
	id: string,
	inputTokens: number | null,
	cacheReadTokens: number | null,
) => ({
	id,
	started: instant(100),
	ended: instant(900),
	status: "succeeded",
	inputTokens,
	cacheReadTokens,
	outputTokens: 20,
	reasoningTokens: 11,
});

test("conversation timing uses the run and job, and usage uses the attempt", () => {
	const reply = { runId: "run-1", jobId: "job-1" };
	const attempt = {
		...reply,
		attemptId: "attempt-1",
		purpose: "llm",
		phase: "generation",
	};
	const cancelled = { runId: "run-2", jobId: "job-2" };
	const logs = [
		event(900, "queue.settled", { jobId: reply.jobId, status: "completed" }),
		event(100, "dialogue.accepted", reply),
		event(150, "dialogue.generation_started", reply),
		event(250, "dialogue.router_selection", { ...reply, durationMs: 100 }),
		event(240, "inference.router_usage", {
			...reply,
			durationMs: 90,
			promptTokens: 50,
			cachedTokens: 0,
		}),
		event(251, "inference.attempt_started", attempt),
		event(254, "inference.codex_thread", {
			attemptId: "attempt-1",
			mode: "reset",
		}),
		event(272, "inference.codex_usage_updated", { attemptId: "attempt-1" }),
		event(380, "inference.codex_usage_updated", { attemptId: "attempt-1" }),
		event(500, "dialogue.first_delta", { ...reply, kind: "streamed" }),
		event(520, "voice.first_chunk_ready", reply),
		event(600, "inference.attempt_succeeded", attempt),
		event(700, "inference.attempt_started", {
			attemptId: "agency-1",
			purpose: "llm",
			subjectId: "background:agency:step",
		}),
		event(200, "dialogue.accepted", cancelled),
		event(201, "inference.attempt_started", {
			...cancelled,
			attemptId: "attempt-2",
			purpose: "llm",
			phase: "generation",
		}),
		event(230, "dialogue.first_delta", { ...cancelled, kind: "streamed" }),
		event(233, "inference.codex_usage_updated", { attemptId: "attempt-2" }),
		event(240, "queue.settled", {
			jobId: cancelled.jobId,
			status: "cancelled",
		}),
		event(10_000, "dialogue.accepted", { runId: "outside" }),
	];
	const saved = [
		usage("attempt-1", 100, 80),
		usage("attempt-2", 90, null),
		usage("agency-1", 200, 0),
		usage("unknown", 10, 0),
	];
	const report = conversationPerformance(logs, start, end, saved);
	expect(report.accepted).toBe(2);
	expect(report.jobs).toMatchObject({ completed: 1, cancelled: 1 });
	expect(report.completedTimingMs).toMatchObject({
		acceptToStart: { count: 1, p50: 50 },
		acceptToFirstBody: { count: 1, p50: 400, p90: 400 },
		attemptToFirstBody: { count: 1, p50: 249 },
		acceptToAudioReady: { count: 1, p50: 420 },
		acceptToSettled: { count: 1, p50: 800 },
		firstBodyToSettled: { count: 1, p50: 400 },
		router: { count: 1, p50: 100 },
	});
	expect(report.attempts).toMatchObject({ reply: 2, background: 1 });
	expect(report.directRouter).toMatchObject({
		observedCalls: 1,
		inputTokens: 50,
		cacheReadTokens: 0,
	});
	expect(report.codex.reply).toMatchObject({
		modes: { reset: 1, append: 0 },
		usageUpdates: { observed: 3, attempts: 2, multipleUpdateAttempts: 1 },
		usage: {
			calls: 2,
			withCacheCounts: 1,
			inputTokens: 190,
			cacheMeasuredInputTokens: 100,
			uncachedInputTokens: 20,
			cacheReadShare: 0.8,
			outputTokens: 40,
			reasoningTokens: 22,
		},
	});
	expect(report.codex.background?.usage?.uncachedInputTokens).toBe(200);
	expect(report.codex.unlinked?.usage?.calls).toBe(1);
	const selected = conversationPerformance(
		logs,
		start,
		end,
		saved,
		new Set([reply.runId]),
	);
	expect(selected.codex.reply?.usage?.calls).toBe(1);
	expect(selected.codex.reply?.usageUpdates).toEqual({
		observed: 2,
		attempts: 1,
		multipleUpdateAttempts: 1,
	});
	expect(selected.codex.background?.usage?.calls).toBe(1);
});

test("logs alone preserve missing usage and skip held text", () => {
	const report = conversationPerformance(
		[
			event(100, "dialogue.accepted", { runId: "run", jobId: "job" }),
			event(200, "dialogue.first_delta", { runId: "run", kind: "held" }),
			event(300, "queue.settled", { jobId: "job", status: "completed" }),
		],
		start,
		end,
	);
	expect(report.codex.reply?.usage).toBeNull();
	expect(report.codex.reply?.usageUpdates).toBeNull();
	expect(report.completedTimingMs.acceptToFirstBody).toMatchObject({
		count: 0,
		p50: null,
	});
	expect(report.stageTimingMs).toEqual([]);
	expect(report.larmTimingMs.providerPrefill).toMatchObject({
		count: 0,
		p50: null,
	});
});

test("stage timings follow selected runs, separate outcomes and preserve missing provider metrics", () => {
	const stage = {
		component: "inference",
		phase: "provider",
		purpose: "llm",
		source: "larm",
	};
	const logs = [
		event(100, "dialogue.accepted", { runId: "run" }),
		event(110, "dialogue.accepted", { runId: "other" }),
		event(175, "performance.stage", {
			...stage,
			runId: "run",
			outcome: "ok",
			durationMs: 25,
		}),
		event(180, "performance.stage", {
			...stage,
			runId: "run",
			outcome: "ok",
			durationMs: 45,
		}),
		event(200, "performance.stage", {
			...stage,
			runId: "run",
			outcome: "error",
			durationMs: 90,
		}),
		event(201, "performance.stage", {
			...stage,
			runId: "run",
			outcome: "ok",
			durationMs: -5,
		}),
		event(210, "performance.stage", {
			...stage,
			runId: "other",
			outcome: "ok",
			durationMs: 900,
		}),
		event(211, "performance.stage", {
			...stage,
			outcome: "ok",
			durationMs: 900,
		}),
		event(220, "inference.prepared", { ...stage, runId: "run", durationMs: 0 }),
		event(225, "larm.llm_timing", {
			runId: "run",
			outcome: "ok",
			providerTtftMs: 30,
			providerPromptMs: 0,
		}),
	];
	const report = conversationPerformance(
		logs,
		start,
		end,
		undefined,
		new Set(["run"]),
	);
	expect(report.stageTimingMs).toMatchObject([
		{ ...stage, outcome: "error", count: 1, p50: 90, p90: 90 },
		{ ...stage, outcome: "ok", count: 2, p50: 35, p90: 45 },
		{ phase: "attempt_prepare", count: 1, p50: 0 },
	]);
	expect(report.larmTimingMs).toMatchObject({
		firstBodyAfterSend: { count: 1, p50: 30 },
		providerPrefill: { count: 1, p50: 0 },
		providerDecode: { count: 0, p50: null },
	});
});

test("reads the published usage dashboard pages and rejects a changed result set", async () => {
	const artifactRevisionId = "artifact:usage.dashboard@2";
	const pages: number[] = [];
	let changed = false;
	const client: Parameters<typeof readCodexUsage>[0] = {
		toolchainArtifacts: async () => [
			{ artifactRevisionId, title: "Usage", adapterRef: "adapter:usage@1" },
		],
		async toolchainArtifactSource(ref, source, _target, _signal, params) {
			expect(ref).toBe(artifactRevisionId);
			expect(source).toBe("usage");
			expect(params).toMatchObject({
				start: "2026-11-21",
				end: "2026-11-21",
				service: "codex",
			});
			const { pageIndex } = params as { pageIndex: number };
			pages.push(pageIndex);
			return {
				revision: 0,
				data: {
					kind: "usage-dashboard",
					query: { pageIndex },
					pageSize: 1,
					total: changed && pageIndex ? 3 : 2,
					rows: [usage(`attempt-${pageIndex}`, 100, null)],
				},
			};
		},
	};
	const signal = new AbortController().signal;
	expect(
		(await readCodexUsage(client, start, end, signal)).map((r) => r.id),
	).toEqual(["attempt-0", "attempt-1"]);
	expect(pages).toEqual([0, 1]);
	changed = true;
	await expect(readCodexUsage(client, start, end, signal)).rejects.toThrow(
		"codex_usage_changed_during_read",
	);
});

test("call kinds count outcomes and name the section where the prefix broke", () => {
	const section = (
		role: string,
		label: string,
		tokens: number,
		hash: string,
	) => ({
		role,
		label,
		tokens,
		hash,
	});
	const system = section("system", "system", 1000, "s1");
	const memory = (hash: string) => section("user", "Memory", 300, hash);
	const state = (hash: string) => section("user", "State", 50, hash);
	const call = (
		at: number,
		attemptId: string,
		fields: LogEntry,
		sections: ReturnType<typeof section>[],
		end: "inference.attempt_succeeded" | "inference.attempt_failed" | null,
		reason?: string,
		bootId = "boot-1",
	) => {
		const base = { attemptId, purpose: "llm", source: "larm", ...fields };
		return [
			event(at, "inference.attempt_started", base),
			event(at + 1, "inference.input_sections", {
				...base,
				bootId,
				conversationId: "conv-1",
				count: sections.length,
				sections: encodeSections(sections),
			}),
			...(end ? [event(at + 50, end, { ...base, reason })] : []),
		];
	};
	const replyOf = (n: number) => ({
		runId: `run-${n}`,
		jobId: `job-${n}`,
		phase: "generation",
	});
	const logs = [
		...[1, 2, 3, 4].map((n) =>
			event(n * 1000, "dialogue.accepted", {
				runId: `run-${n}`,
				jobId: `job-${n}`,
			}),
		),
		...call(
			1000,
			"r1",
			replyOf(1),
			[system, memory("m1"), state("t1")],
			"inference.attempt_succeeded",
		),
		// The state changed: the prefix matches through Memory.
		...call(
			2000,
			"r2",
			replyOf(2),
			[system, memory("m1"), state("t2")],
			"inference.attempt_succeeded",
		),
		// The memory changed: only the system section matches.
		...call(
			3000,
			"r3",
			replyOf(3),
			[system, memory("m2"), state("t3")],
			"inference.attempt_failed",
			"network_unavailable",
		),
		...call(
			4000,
			"r4",
			replyOf(4),
			[system, memory("m2"), state("t3"), section("user", "text", 20, "u1")],
			"inference.attempt_failed",
			"cancelled",
		),
		...call(
			5000,
			"b1",
			{ subjectId: "background:warm:1763700000000" },
			[system, memory("m1")],
			"inference.attempt_succeeded",
		),
		...call(
			6000,
			"b2",
			{ subjectId: "background:warm:1763700006000" },
			[system, memory("m1")],
			"inference.attempt_succeeded",
		),
		// Another process hashes with its own key: it is not compared with the calls above.
		...call(
			6500,
			"b4",
			{ subjectId: "background:warm:1763700006500" },
			[system, memory("m1")],
			"inference.attempt_succeeded",
			undefined,
			"boot-2",
		),
		...call(
			6800,
			"b5",
			{ subjectId: "background:warm:1763700006800" },
			[system, memory("m1")],
			null,
		),
		...call(
			7000,
			"b3",
			{ subjectId: "background:prewarm:1763700007000" },
			[system],
			"inference.attempt_succeeded",
		),
	];
	const report = conversationPerformance(logs, start, end, [
		usage("r1", 1000, 600),
		usage("r2", 1000, 900),
	]);
	const kinds = Object.fromEntries(report.callKinds.map((k) => [k.kind, k]));
	expect(Object.keys(kinds).sort()).toEqual([
		"background:prewarm",
		"background:warm",
		"reply",
	]);
	expect(kinds.reply).toMatchObject({
		calls: 4,
		succeeded: 2,
		failed: 1,
		interrupted: 1,
		unfinished: 0,
		usage: {
			calls: 2,
			inputTokens: 2000,
			cacheReadTokens: 1500,
			uncachedInputTokens: 500,
		},
		inputSections: { observed: 4, meanEstimatedInputTokens: 1355 },
	});
	// Only succeeded calls are compared (r1, r2): the failed r3 and the withdrawn r4 are left out.
	expect(kinds.reply!.prefix).toEqual({
		pairs: 1,
		breaks: [
			{
				label: "State",
				count: 1,
				meanMatchedTokens: 1300,
				meanInputTokens: 1350,
			},
		],
	});
	expect(kinds["background:warm"]).toMatchObject({
		calls: 4,
		succeeded: 3,
		unfinished: 1,
		usage: { calls: 0 },
	});
	expect(kinds["background:warm"]!.prefix.breaks).toEqual([
		{
			label: "(identical)",
			count: 1,
			meanMatchedTokens: 1300,
			meanInputTokens: 1300,
		},
	]);
	// A single call has nothing to be compared with.
	expect(kinds["background:prewarm"]!.prefix).toEqual({ pairs: 0, breaks: [] });
	// Without usage the token side is absent, not zero.
	expect(
		conversationPerformance(logs, start, end).callKinds[0]!.usage,
	).toBeNull();
});
