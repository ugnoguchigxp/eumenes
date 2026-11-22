import { expect, test } from "bun:test";
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
