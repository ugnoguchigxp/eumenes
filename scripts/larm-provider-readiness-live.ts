import { mkdirSync, writeFileSync } from "node:fs";
import { createLiveLarm } from "./live-larm";
import { configureLogging, flushLogging } from "../api/infrastructure/logger";
import { toErrorCode } from "../api/infrastructure/error-code";

/** Only synthetic inputs. Summaries contain timings/state, never content or credentials. */
if (!process.argv.includes("--run")) throw new Error("live_requires_run");
const directory = "verification-reports/larm-provider-readiness-2026-10-25";
mkdirSync(directory, { recursive: true, mode: 0o700 });
configureLogging({ file: `${directory}/adapter.jsonl`, destination: { write() {} } });
const events: Record<string, unknown>[] = [];
const started = performance.now();
let phase = "new";
const ids = new Set<string>();
const postStart = new Map<string, number>();
const observe: typeof fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
	const url = new URL(String(input));
	const method = init?.method ?? "GET";
	const begin = performance.now();
	const response = await fetch(input, init);
	if (url.pathname.startsWith("/v1/agent-connections") && response.ok && response.status !== 204) {
		const body = await response.clone().json() as Record<string, unknown>;
		const id = String(body.id);
		if (method === "POST" && url.pathname === "/v1/agent-connections") {
			ids.add(id); postStart.set(id, begin);
		}
		const providers = Array.isArray(body.providers) ? body.providers as Record<string, unknown>[] : [];
		events.push({ phase, atMs: Math.round(begin - started), durationMs: Math.round(performance.now() - begin),
			operation: url.pathname.endsWith("/claim") ? "claim" : url.pathname.endsWith("/renew") ? "renew" : method === "POST" ? "create" : "get",
			connectionId: id, status: body.status,
			providers: providers.map(p => ({ name: p.name, ...(p.readiness ? { readiness: p.readiness } : {}) })),
			...(url.pathname.endsWith("/claim") ? { selected: JSON.parse(String(init?.body)).providers } : {}),
			fromPostMs: Math.round(performance.now() - (postStart.get(id) ?? begin)),
		});
	}
	return response;
}, fetch);
const main = createLiveLarm(process.env, { fetch: observe });
const background = createLiveLarm(process.env, { fetch: observe });
const voice = createLiveLarm(process.env, { fetch: observe });
const results: Record<string, unknown>[] = [];
const save = () => writeFileSync(`${directory}/live.json`, JSON.stringify({ results, events }, null, 2), { mode: 0o600 });
const signal = () => AbortSignal.timeout(60_000);
async function speech() {
	const ttsStart = performance.now();
	const audio = await voice.speak("接続の確認です。今日もよろしくお願いします。", signal());
	const ttsMs = Math.round(performance.now() - ttsStart);
	const asrStart = performance.now();
	const text = await voice.transcribe(audio, signal());
	if (!text.trim()) throw new Error("synthetic_transcript_empty");
	results.push({ phase, ttsMs, asrMs: Math.round(performance.now() - asrStart), cloudFallback: false,
		fallbackReason: "adapter_uses_larm_only", pass: true }); save();
}
const cancel = new AbortController();
try {
	// The first ASR consumes a pre-existing synthetic WAV while its own connection is new.
	const seed = await main.speak("音声の接続を確認します。", signal());
	const asrStart = performance.now();
	const transcript = await voice.transcribe(seed, signal());
	if (!transcript.trim()) throw new Error("synthetic_transcript_empty");
	results.push({ phase, asrMs: Math.round(performance.now() - asrStart), pass: true, cloudFallback: false });
	await speech();
	phase = "llm_generating";
	let active = 0;
	const generation = (port: typeof main) => port.answerStream!(
		[{ role: "user", content: "1から300までの整数を順に列挙してください。説明は不要です。" }],
		AbortSignal.any([cancel.signal, AbortSignal.timeout(120_000)]), () => {}, { maxOutputTokens: 512 },
	).then(() => ({ pass: true }), error => ({ pass: false, code: toErrorCode(error, "llm_failed") })).finally(() => { active--; });
	active = 2;
	const work = [generation(main), generation(background)];
	await new Promise(resolve => setTimeout(resolve, 250));
	const activeAtStart = active;
	await speech();
	results.push({ phase, llmRequestsInFlightAtAudioStart: activeAtStart, llmRequestsInFlightAtAudioEnd: active });
	cancel.abort();
	results.push({ phase, generations: await Promise.all(work) });
	phase = "after_llm_cancel";
	await speech();
	const unusedSince = Date.now();
	phase = "idle_10_minutes";
	results.push({ phase, startedAt: new Date(unusedSince).toISOString(), status: "waiting" }); save();
	console.log(JSON.stringify({ phase, status: "waiting", waitMs: 600_100 }));
	await new Promise(resolve => setTimeout(resolve, 600_100));
	phase = "after_idle_10_minutes";
	results.push({ phase, idleMs: Date.now() - unusedSince });
	await speech();
} catch (error) {
	results.push({ phase, pass: false, code: toErrorCode(error, "live_failed") });
	process.exitCode = 1;
} finally {
	cancel.abort();
	await Promise.all([main.close(), background.close(), voice.close()]);
	results.push({ phase: "cleanup", ownedConnectionCount: ids.size, pass: true });
	await flushLogging(); save();
	console.log(JSON.stringify({ results, report: `${directory}/live.json` }));
}
