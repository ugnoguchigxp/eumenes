import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { readApiToken } from "../api/infrastructure/auth-config";
import { jstDay, jstIso, parseTimeJst } from "../api/infrastructure/jst-time";
import {
	createLogReader,
	defaultLogFile,
	type LogEntry,
	logGenerations,
	logTimeMs,
} from "../api/infrastructure/log-reader";
import { decodeSections } from "../api/domains/inference/service/input-sections";
import { createClient } from "../client";
import { median } from "./verification-metrics";

const events =
	/dialogue\.(accepted|generation_started|router_selection|first_delta)|voice\.first_chunk_ready|queue\.settled|inference\.(attempt_(started|succeeded|failed)|input_sections|codex_thread|codex_usage_updated|prepared|router_usage)|performance\.stage|larm\.llm_timing/;
const attemptEvents = new Set([
	"inference.attempt_started",
	"inference.attempt_succeeded",
	"inference.attempt_failed",
]);
const terminal = new Set([
	"completed",
	"failed",
	"cancelled",
	"expired",
	"interrupted",
	"outcome_unknown",
]);
const stages = ["reply", "background", "unlinked"] as const;
const modes = ["new", "reset", "append"] as const;

const tokenCount = z.number().int().nonnegative().nullable();
const codexUsageRow = z.object({
	id: z.string(),
	started: z.iso.datetime({ offset: true }),
	ended: z.iso.datetime({ offset: true }).nullable(),
	status: z.string(),
	inputTokens: tokenCount,
	cacheReadTokens: tokenCount,
	outputTokens: tokenCount,
	reasoningTokens: tokenCount,
});
const usagePage = z.object({
	kind: z.literal("usage-dashboard"),
	query: z.object({ pageIndex: z.number().int().nonnegative() }),
	total: z.number().int().nonnegative(),
	pageSize: z.number().int().positive(),
	rows: z.array(codexUsageRow),
});
type Usage = z.infer<typeof codexUsageRow>;
type Stage = (typeof stages)[number];

function duration(value: unknown) {
	return typeof value === "number" && Number.isFinite(value) && value >= 0
		? value
		: null;
}

function stats(values: (number | null)[]) {
	const measured = values
		.filter((n): n is number => n !== null)
		.sort((a, b) => a - b);
	return {
		count: measured.length,
		p50: median(measured),
		p90: measured[Math.ceil(measured.length * 0.9) - 1] ?? null,
		max: measured.at(-1) ?? null,
	};
}

function sumReported(values: (number | null | undefined)[]) {
	const reported = values.filter(
		(value): value is number => typeof value === "number",
	);
	return reported.length
		? reported.reduce((sum, value) => sum + value, 0)
		: null;
}

function tokens(
	rows: (Pick<Usage, "inputTokens" | "cacheReadTokens"> &
		Partial<Pick<Usage, "outputTokens" | "reasoningTokens">>)[],
) {
	const measured = rows.filter(
		(r) =>
			r.inputTokens !== null &&
			r.cacheReadTokens !== null &&
			r.cacheReadTokens <= r.inputTokens,
	);
	const input = measured.reduce((n, r) => n + r.inputTokens!, 0);
	const cached = measured.reduce((n, r) => n + r.cacheReadTokens!, 0);
	return {
		withCacheCounts: measured.length,
		inputTokens: sumReported(rows.map((r) => r.inputTokens)),
		cacheMeasuredInputTokens: measured.length ? input : null,
		cacheReadTokens: measured.length ? cached : null,
		uncachedInputTokens: measured.length ? input - cached : null,
		cacheReadShare: input ? cached / input : null,
		outputTokens: sumReported(rows.map((r) => r.outputTokens)),
		reasoningTokens: sumReported(rows.map((r) => r.reasoningTokens)),
	};
}

/** Attempts that ended because the call was withdrawn, not because the provider failed. */
const interruptedReasons = new Set([
	"cancelled",
	"permission_revoked",
	"larm_preempted",
]);

/**
 * The kind of a background call from its subject (`background:<name>[:<id>...]`): the segments that look like an
 * ID or a time (any digit, or 16+ characters) are left out, the first two others name the kind.
 */
export function backgroundKind(subjectId: string) {
	const names = subjectId
		.split(":")
		.slice(1)
		.filter((part) => part && !/\d/.test(part) && part.length < 16);
	return names.length
		? `background:${names.slice(0, 2).join(":")}`
		: "background";
}

type CallAttempt = {
	kind: string;
	source: string | null;
	outcome: "succeeded" | "failed" | "interrupted" | "unfinished";
	conversationId: string | null;
	/** The process that wrote the hashes: they are keyed per process, so only one process's calls are compared. */
	bootId: string | null;
	sections: ReturnType<typeof decodeSections> | null;
};

const mean = (values: number[]) =>
	values.length
		? Math.round(values.reduce((a, b) => a + b, 0) / values.length)
		: null;

/**
 * Where a call's input first differs from the previous succeeded call of the same kind, session and process, and
 * what matched.
 */
function prefixBreaks(calls: CallAttempt[]) {
	const sequences = new Map<string, NonNullable<CallAttempt["sections"]>[]>();
	for (const call of calls) {
		// Only succeeded calls are compared: a failed or withdrawn one may not have filled the provider's cache.
		if (!call.sections || call.outcome !== "succeeded") continue;
		const key = JSON.stringify([call.source, call.conversationId, call.bootId]);
		sequences.set(key, [...(sequences.get(key) ?? []), call.sections]);
	}
	const bins = new Map<string, { matched: number[]; total: number[] }>();
	let pairs = 0;
	for (const sequence of sequences.values())
		for (let i = 1; i < sequence.length; i++) {
			const before = sequence[i - 1]!;
			const now = sequence[i]!;
			let at = 0;
			while (
				at < before.length &&
				at < now.length &&
				before[at]!.hash === now[at]!.hash
			)
				at++;
			const label =
				at === now.length && at === before.length
					? "(identical)"
					: at === before.length
						? "(appended)"
						: at === now.length
							? "(shortened)"
							: now[at]!.label;
			const bin = bins.get(label) ?? { matched: [], total: [] };
			bin.matched.push(now.slice(0, at).reduce((n, x) => n + x.tokens, 0));
			bin.total.push(now.reduce((n, x) => n + x.tokens, 0));
			bins.set(label, bin);
			pairs++;
		}
	return {
		pairs,
		breaks: [...bins]
			.map(([label, bin]) => ({
				label,
				count: bin.matched.length,
				meanMatchedTokens: mean(bin.matched),
				meanInputTokens: mean(bin.total),
			}))
			.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)),
	};
}

/** Per call kind (the conversation's reply, or a background name): counts, usage and where the prefix broke. */
function callKinds(
	entries: LogEntry[],
	attempts: ReadonlyMap<string, Stage | "excluded">,
	usage: readonly Usage[],
	hasUsage: boolean,
) {
	const calls = new Map<string, CallAttempt>();
	for (const entry of entries) {
		const id = entry.attemptId;
		if (typeof id !== "string" || entry.purpose !== "llm") continue;
		const stage = attempts.get(id);
		if (!stage || stage === "excluded") continue;
		const text = (value: unknown) => (typeof value === "string" ? value : null);
		const call = calls.get(id) ?? {
			kind:
				stage === "reply"
					? "reply"
					: stage === "background"
						? backgroundKind(text(entry.subjectId) ?? "")
						: "unlinked",
			source: null,
			outcome: "unfinished" as const,
			conversationId: null,
			bootId: null,
			sections: null,
		};
		call.source ??= text(entry.source);
		if (entry.event === "inference.attempt_succeeded")
			call.outcome = "succeeded";
		if (entry.event === "inference.attempt_failed")
			call.outcome = interruptedReasons.has(String(entry.reason))
				? "interrupted"
				: "failed";
		if (entry.event === "inference.input_sections") {
			call.conversationId = text(entry.conversationId);
			call.bootId = text(entry.bootId);
			call.sections = decodeSections(text(entry.sections) ?? "");
		}
		calls.set(id, call);
	}
	const kinds = new Map<string, [string, CallAttempt][]>();
	for (const item of calls) {
		const group = kinds.get(item[1].kind) ?? [];
		group.push(item);
		kinds.set(item[1].kind, group);
	}
	return [...kinds]
		.map(([kind, group]) => {
			const rows = usage.filter((row) => calls.get(row.id)?.kind === kind);
			const count = (outcome: CallAttempt["outcome"]) =>
				group.filter(([, c]) => c.outcome === outcome).length;
			const observed = group.flatMap(([, c]) =>
				c.sections ? [c.sections] : [],
			);
			return {
				kind,
				calls: group.length,
				succeeded: count("succeeded"),
				failed: count("failed"),
				interrupted: count("interrupted"),
				unfinished: count("unfinished"),
				usage: hasUsage ? { calls: rows.length, ...tokens(rows) } : null,
				inputSections: {
					observed: observed.length,
					meanEstimatedInputTokens: mean(
						observed.map((s) => s.reduce((n, x) => n + x.tokens, 0)),
					),
				},
				prefix: prefixBreaks(group.map(([, c]) => c)),
			};
		})
		.sort((a, b) => b.calls - a.calls || a.kind.localeCompare(b.kind));
}

function dialogueRuns(entries: LogEntry[], runIds?: ReadonlySet<string>) {
	const runs = new Map<string, LogEntry[]>();
	const jobs = new Map<string, string>();
	for (const entry of entries) {
		const runId = entry.runId;
		if (typeof runId !== "string" || (runIds && !runIds.has(runId))) continue;
		if (entry.event === "dialogue.accepted") runs.set(runId, []);
		if (
			(entry.event === "dialogue.accepted" ||
				entry.event === "dialogue.generation_started") &&
			typeof entry.jobId === "string"
		)
			jobs.set(entry.jobId, runId);
	}
	for (const entry of entries) {
		const id =
			entry.event === "queue.settled" && typeof entry.jobId === "string"
				? jobs.get(entry.jobId)
				: entry.runId;
		if (typeof id === "string") runs.get(id)?.push(entry);
	}
	return runs;
}

function runTiming(entries: LogEntry[]) {
	const first = (event: string) =>
		entries.find((entry) => entry.event === event);
	const accepted = logTimeMs(first("dialogue.accepted")!);
	const generation = first("dialogue.generation_started");
	const lastJob =
		entries.findLast(
			(e) =>
				e.event === "dialogue.generation_started" &&
				typeof e.jobId === "string",
		)?.jobId ?? first("dialogue.accepted")!.jobId;
	const settled = entries.findLast(
		(e) => e.event === "queue.settled" && e.jobId === lastJob,
	);
	const delta = entries.find(
		(e) => e.event === "dialogue.first_delta" && e.kind === "streamed",
	);
	const firstAttempt = entries.find(
		(e) =>
			e.event === "inference.attempt_started" &&
			e.purpose === "llm" &&
			e.phase === "generation",
	);
	const elapsed = (entry: LogEntry | undefined, from = accepted) =>
		entry ? duration(logTimeMs(entry) - from) : null;
	const router = entries.filter(
		(e) =>
			e.event === "dialogue.router_selection" ||
			e.event === "dialogue.router_selection_failed",
	);
	const selections = router.map((e) => duration(e.durationMs));
	const status = String(settled?.status ?? "");
	return {
		outcome: terminal.has(status) ? status : "unsettled",
		acceptToStartMs: elapsed(generation),
		routerMs:
			selections.length && selections.every((n) => n !== null)
				? selections.reduce((a, b) => a + b, 0)
				: null,
		attemptToFirstBodyMs: firstAttempt
			? elapsed(delta, logTimeMs(firstAttempt))
			: null,
		acceptToFirstBodyMs: elapsed(delta),
		acceptToAudioReadyMs: elapsed(first("voice.first_chunk_ready")),
		acceptToSettledMs: terminal.has(status) ? elapsed(settled) : null,
		firstBodyToSettledMs: delta ? elapsed(settled, logTimeMs(delta)) : null,
	};
}

/** Include the stages of failed and cancelled turns as well as completed ones. */
function stageTimings(entries: LogEntry[]) {
	const bins = new Map<
		string,
		{
			component: string;
			phase: string;
			purpose: string | null;
			source: string | null;
			kind: string | null;
			mode: string | null;
			outcome: "ok" | "error";
			times: number[];
		}
	>();
	const label = (value: unknown) => (typeof value === "string" ? value : null);
	for (const entry of entries) {
		const prepared = entry.event === "inference.prepared";
		if (!prepared && entry.event !== "performance.stage") continue;
		const component = label(entry.component);
		const phase = prepared ? "attempt_prepare" : label(entry.phase);
		const outcome = prepared ? "ok" : entry.outcome;
		const ms = duration(entry.durationMs);
		if (
			!component ||
			!phase ||
			(outcome !== "ok" && outcome !== "error") ||
			ms === null
		)
			continue;
		const group = {
			component,
			phase,
			purpose: label(entry.purpose),
			source: label(entry.source),
			kind: label(entry.kind),
			mode: label(entry.mode),
			outcome,
		};
		const key = JSON.stringify(group);
		const bin = bins.get(key);
		if (bin) bin.times.push(ms);
		else bins.set(key, { ...group, outcome, times: [ms] });
	}
	return [...bins.values()]
		.map(({ times, ...group }) => ({ ...group, ...stats(times) }))
		.sort((a, b) => (b.p90 ?? 0) - (a.p90 ?? 0));
}

export function conversationPerformance(
	logs: LogEntry[],
	since: number,
	until: number,
	usage?: readonly Usage[],
	runIds?: ReadonlySet<string>,
) {
	const inPeriod = (at: number) => at >= since && at < until;
	const entries = logs
		.filter((e) => inPeriod(logTimeMs(e)))
		.sort((a, b) => logTimeMs(a) - logTimeMs(b));
	const runs = dialogueRuns(entries, runIds);
	const turns = [...runs.values()].map(runTiming);
	const completed = turns.filter((t) => t.outcome === "completed");
	const runEntries = [...runs.values()].flat();
	const larmTiming = runEntries.filter(
		(e) => e.event === "larm.llm_timing" && e.outcome === "ok",
	);
	const attempts = new Map<string, Stage | "excluded">();
	const threadModes = new Map<string, string>();
	const usageUpdates = new Map<string, number>();
	for (const entry of entries) {
		if (typeof entry.attemptId !== "string") continue;
		if (
			entry.event === "inference.codex_thread" &&
			typeof entry.mode === "string"
		)
			threadModes.set(entry.attemptId, entry.mode);
		if (entry.event === "inference.codex_usage_updated")
			usageUpdates.set(
				entry.attemptId,
				(usageUpdates.get(entry.attemptId) ?? 0) + 1,
			);
		if (!attemptEvents.has(String(entry.event)) || entry.purpose !== "llm")
			continue;
		const stage =
			entry.phase === "generation" && typeof entry.runId === "string"
				? runIds && !runIds.has(entry.runId)
					? "excluded"
					: "reply"
				: typeof entry.subjectId === "string" &&
					  entry.subjectId.startsWith("background:")
					? "background"
					: "unlinked";
		if (stage !== "unlinked" || !attempts.has(entry.attemptId))
			attempts.set(entry.attemptId, stage);
	}
	const directRouter = entries.filter(
		(e) =>
			e.event === "inference.router_usage" &&
			typeof e.runId === "string" &&
			runs.has(e.runId),
	);
	const savedUsage = new Map<string, Usage>();
	for (const row of usage ?? [])
		if (
			row.ended &&
			inPeriod(Date.parse(row.started)) &&
			inPeriod(Date.parse(row.ended))
		)
			savedUsage.set(row.id, row);
	return {
		period: { since: jstIso(since), until: jstIso(until) },
		accepted: turns.length,
		jobs: Object.fromEntries(
			[...terminal, "unsettled"].map((status) => [
				status,
				turns.filter((t) => t.outcome === status).length,
			]),
		),
		completedTimingMs: {
			acceptToStart: stats(completed.map((t) => t.acceptToStartMs)),
			router: stats(completed.map((t) => t.routerMs)),
			attemptToFirstBody: stats(completed.map((t) => t.attemptToFirstBodyMs)),
			acceptToFirstBody: stats(completed.map((t) => t.acceptToFirstBodyMs)),
			acceptToAudioReady: stats(completed.map((t) => t.acceptToAudioReadyMs)),
			acceptToSettled: stats(completed.map((t) => t.acceptToSettledMs)),
			firstBodyToSettled: stats(completed.map((t) => t.firstBodyToSettledMs)),
		},
		stageTimingMs: stageTimings(runEntries),
		larmTimingMs: {
			firstBodyAfterSend: stats(
				larmTiming.map((e) => duration(e.providerTtftMs)),
			),
			providerPrefill: stats(
				larmTiming.map((e) => duration(e.providerPromptMs)),
			),
			providerDecode: stats(
				larmTiming.map((e) => duration(e.providerDecodeMs)),
			),
		},
		callKinds: callKinds(
			entries,
			attempts,
			[...savedUsage.values()],
			usage !== undefined,
		),
		attempts: Object.fromEntries(
			stages.map((stage) => [
				stage,
				[...attempts.values()].filter((s) => s === stage).length,
			]),
		),
		directRouter: {
			observedCalls: directRouter.length,
			timingMs: stats(directRouter.map((e) => duration(e.durationMs))),
			...tokens(
				directRouter.map((e) => ({
					inputTokens: duration(e.promptTokens),
					cacheReadTokens: duration(e.cachedTokens),
					outputTokens: duration(e.completionTokens),
				})),
			),
		},
		codex: Object.fromEntries(
			stages.map((stage) => {
				const modeCounts = modes.map(
					(mode) =>
						[...threadModes].filter(
							([id, name]) =>
								name === mode && (attempts.get(id) ?? "unlinked") === stage,
						).length,
				);
				const rows = [...savedUsage.values()].filter(
					(r) => (attempts.get(r.id) ?? "unlinked") === stage,
				);
				const updates = [...usageUpdates].flatMap(([id, count]) =>
					(attempts.get(id) ?? "unlinked") === stage ? [count] : [],
				);
				return [
					stage,
					{
						modes: Object.fromEntries(
							modes.map((mode, i) => [mode, modeCounts[i]]),
						),
						usageUpdates: updates.length
							? {
									observed: updates.reduce((sum, count) => sum + count, 0),
									attempts: updates.length,
									multipleUpdateAttempts: updates.filter((count) => count > 1)
										.length,
								}
							: null,
						usage: usage
							? {
									calls: rows.length,
									succeeded: rows.filter((r) => r.status === "succeeded")
										.length,
									...tokens(rows),
								}
							: null,
					},
				];
			}),
		),
	};
}

export async function readCodexUsage(
	client: Pick<
		ReturnType<typeof createClient>,
		"toolchainArtifacts" | "toolchainArtifactSource"
	>,
	since: number,
	until: number,
	signal: AbortSignal,
) {
	const artifacts = await client.toolchainArtifacts(signal);
	const dashboard = artifacts.find((a) =>
		a.artifactRevisionId.startsWith("artifact:usage.dashboard@"),
	);
	if (!dashboard) throw new Error("codex_usage_dashboard_unavailable");
	const page = async (pageIndex: number) =>
		usagePage.parse(
			(
				await client.toolchainArtifactSource(
					dashboard.artifactRevisionId,
					"usage",
					undefined,
					signal,
					{
						start: jstDay(since),
						end: jstDay(until - 1),
						service: "codex",
						model: "",
						connectionId: "",
						pageIndex,
					},
				)
			).data,
		);
	const first = await page(0);
	const rows = new Map(first.rows.map((row) => [row.id, row]));
	for (let i = 1; i * first.pageSize < first.total; i++) {
		const next = await page(i);
		if (
			next.query.pageIndex !== i ||
			next.pageSize !== first.pageSize ||
			next.total !== first.total
		)
			throw new Error("codex_usage_changed_during_read");
		for (const row of next.rows) rows.set(row.id, row);
	}
	if (rows.size !== first.total)
		throw new Error("codex_usage_changed_during_read");
	return [...rows.values()];
}

async function main() {
	const { values } = parseArgs({
		options: {
			file: { type: "string" },
			since: { type: "string" },
			until: { type: "string" },
			"run-id": { type: "string", multiple: true },
			"with-usage": { type: "boolean" },
		},
	});
	const since = parseTimeJst(values.since ?? "");
	const until = parseTimeJst(values.until ?? "");
	if (!Number.isFinite(since) || !Number.isFinite(until) || since >= until)
		throw new Error(
			"Specify --since and --until (JST by default). Other options: --file, --run-id, --with-usage.",
		);
	const file = values.file ?? defaultLogFile();
	if (!file || !logGenerations(file).some(existsSync))
		throw new Error("conversation_log_unavailable");
	const entries: LogEntry[] = [];
	const reader = createLogReader(file);
	await reader.read((entry) => {
		const at = logTimeMs(entry);
		if (at >= since && at < until) entries.push(entry);
	}, events);
	let usage: Usage[] | undefined;
	if (values["with-usage"]) {
		try {
			const client = createClient(
				process.env.EUMENES_URL ?? "http://127.0.0.1:8787",
				readApiToken(
					process.env,
					resolve(import.meta.dir, "../data/eumenes.sqlite3"),
				),
			);
			usage = await readCodexUsage(
				client,
				since,
				until,
				AbortSignal.timeout(15_000),
			);
		} catch {
			console.error("Codex usage could not be read from the API.");
			process.exitCode = 1;
		}
	}
	const selected = values["run-id"] ? new Set(values["run-id"]) : undefined;
	console.log(
		JSON.stringify(
			{
				...conversationPerformance(entries, since, until, usage, selected),
				invalidLogLines: reader.invalid,
			},
			null,
			2,
		),
	);
}

if (import.meta.main) {
	await main().catch((error: unknown) => {
		console.error(
			error instanceof Error
				? error.message
				: "conversation_performance_failed",
		);
		process.exitCode = 1;
	});
}
