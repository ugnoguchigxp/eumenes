/**
 * Live trial of the first-round shortening (spec section 8). In-process isolated host (no port is opened),
 * saved LARM connection read-only, calls strictly sequential.
 *
 *   bun scripts/first-round-live.ts --run [--repeat 3] [--fake]
 *
 * --fake uses the fixture model instead of LARM (a dry run of this script only).
 * Output: one JSON line per trial on stdout and a report under --out (default ./verification-reports/first-round-live/<time>).
 * For each trial: the first round's chosen function and analysis, the notice text, the time from the run's submission and from the
 * first round's start to the notice being published, and every model call's phase / duration / tool names
 * together with the provider token counters found in backend.jsonl (prompt / cached / output).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const { harness } = await import(
	`${root}/api/application/toolchain/toolchain.fixture`
);
const { createLiveLarm, liveLarmSettings } = await import(
	`${root}/scripts/live-larm`
);
const { configureLogging } = await import(`${root}/api/infrastructure/logger`);

if (!process.argv.includes("--run")) throw new Error("use --run");
const fake = process.argv.includes("--fake");
const repeatAt = process.argv.indexOf("--repeat");
const repeat = repeatAt > 0 ? Number(process.argv[repeatAt + 1]) : 3;
const outAt = process.argv.indexOf("--out");
const out = resolve(
	outAt > 0
		? process.argv[outAt + 1]!
		: `verification-reports/first-round-live/${new Date().toISOString().replaceAll(":", "-")}`,
);
mkdirSync(out, { recursive: true, mode: 0o700 });
const logFile = join(out, "backend.jsonl");
configureLogging({ file: logFile, destination: { write() {} } });

type Call = { phase: string; tools: string[]; startMs: number; endMs: number };
let calls: Call[] = [];
const phaseOf = (tools?: Array<{ function: { name: string } }>) =>
	tools?.some((t) => t.function.name === "answer")
		? "first-round"
		: tools?.length
			? "second-round"
			: "answer";
const live = fake ? undefined : createLiveLarm();
function wrap(model: any) {
	const track = async (options: any, run: (o: any) => Promise<any>) => {
		const call: Call = {
			phase: phaseOf(options?.tools),
			tools: [],
			startMs: performance.now(),
			endMs: 0,
		};
		calls.push(call);
		try {
			return await run({
				...options,
				onToolCalls: (items: Array<{ name: string }>) => {
					call.tools.push(...items.map((c) => c.name));
					options?.onToolCalls?.(items);
				},
			});
		} finally {
			call.endMs = performance.now();
		}
	};
	return {
		...model,
		answer: (m: any, s: any, o: any) => track(o, (x) => model.answer(m, s, x)),
		answerStream: model.answerStream
			? (m: any, s: any, d: any, o: any) =>
					track(o, (x) => model.answerStream(m, s, d, x))
			: undefined,
	};
}
const h = await harness({
	...(live ? { model: wrap(live) } : {}),
	uiCompositions: true,
	timers: true,
	routeTool: undefined,
});
const trials: unknown[] = [];

async function trial(id: string, text: string) {
	calls = [];
	const t0 = performance.now();
	const response = await h.request("/api/runs", {
		requestId: crypto.randomUUID(),
		conversationId: "main",
		text,
	});
	if (!response.ok) throw new Error("test_submission_failed");
	const run = await response.json();
	let noticeMs: number | undefined;
	let notice: string | undefined;
	const stop = h.dialogue.subscribeProgress(
		run.id,
		(p: { announcement?: string | null }) => {
			if (p.announcement && noticeMs === undefined) {
				noticeMs = performance.now();
				notice = p.announcement;
			}
		},
	);
	// Wait for the notice, an answer or the end; the delegated work itself is not part of this measure.
	const deadline = Date.now() + 90_000;
	while (Date.now() < deadline) {
		const state = h.dialogue.get(run.id);
		if (
			noticeMs !== undefined ||
			["completed", "failed", "cancelled"].includes(state?.status ?? "")
		)
			break;
		await new Promise((r) => setTimeout(r, 25));
	}
	await h.dialogue.cancel(run.id).catch(() => undefined);
	await h.dialogue
		.waitForTerminal(run.id, { timeoutMs: 30_000 })
		.catch(() => undefined);
	stop();
	const first = calls.find((c) => c.phase === "first-round");
	const record = {
		id,
		text,
		runId: run.id,
		firstRoundChose: first?.tools[0] ?? "(none)",
		notice: notice ?? null,
		submitToNoticeMs: noticeMs === undefined ? null : Math.round(noticeMs - t0),
		firstRoundStartToNoticeMs:
			noticeMs === undefined || !first
				? null
				: Math.round(noticeMs - first.startMs),
		calls: calls.map((c) => ({
			phase: c.phase,
			tools: c.tools,
			durationMs: Math.round(c.endMs - c.startMs),
			startOffsetMs: Math.round(c.startMs - t0),
		})),
		status: h.dialogue.get(run.id)?.status,
	};
	trials.push(record);
	console.log(JSON.stringify(record));
}

try {
	if (!fake) {
		const settings = h.settings.get();
		const applied = await h.request("/api/settings/apply", {
			requestId: crypto.randomUUID(),
			expectedRevision: settings.revision,
			settings: { ...settings, larm: liveLarmSettings() },
			keys: [],
		});
		if (!applied.ok) throw new Error("test_settings_not_saved");
	}
	for (let i = 1; i <= repeat; i++) {
		await trial(`weather-${i}`, "明日の鎌倉の天気を教えて");
		await trial(`follow-up-${i}`, "明日は？"); // after the weather run: the earlier utterance is searched too
		await trial(`timer-no-time-${i}`, "タイマー起動して");
		await trial(`timer-6min-${i}`, "6分タイマー起動して");
		await trial(`knowledge-${i}`, "富士山の高さは？");
	}
} finally {
	await h.close();
	writeFileSync(
		join(out, "trials.json"),
		JSON.stringify(trials, null, 2) + "\n",
		{ mode: 0o600 },
	);
	// Provider token counters per call (prompt / cached / output) in the order the backend logged them.
	const rows = readFileSync(logFile, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l))
		.filter((r) => r.providerPromptTokens !== undefined)
		.map((r) => ({
			event: r.event,
			promptTokens: r.providerPromptTokens,
			cachedTokens: r.providerCachedTokens,
			outputTokens: r.providerOutputTokens,
			promptMs: r.providerPromptMs,
			decodeMs: r.providerDecodeMs,
		}));
	writeFileSync(
		join(out, "tokens.json"),
		JSON.stringify(rows, null, 2) + "\n",
		{ mode: 0o600 },
	);
	console.log(
		JSON.stringify({ out, trials: trials.length, tokenRows: rows.length }),
	);
}
