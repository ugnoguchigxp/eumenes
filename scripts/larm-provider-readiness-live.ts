import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createLiveLarm, liveLarmSettings } from "./live-larm";
import { resolveLarmToken } from "../api/infrastructure/auth-config";
import { configureLogging, flushLogging } from "../api/infrastructure/logger";
import { toErrorCode } from "../api/infrastructure/error-code";

/** Synthetic inputs stay in memory; reports contain state/timing/counts only. No API server is started. */
if (!process.argv.includes("--run")) throw new Error("live_requires_run");
const directory = `verification-reports/larm-provider-readiness-2026-10-25/review/${new Date().toISOString().replaceAll(":", "-")}`;
mkdirSync(directory, { recursive: true, mode: 0o700 });
configureLogging({
	file: `${directory}/adapter.jsonl`,
	destination: { write() {} },
});
const saved = liveLarmSettings();
const events: Record<string, unknown>[] = [],
	results: Record<string, unknown>[] = [];
const started = performance.now();
let phase = "new",
	audioCalls = 0;
const owned = new Map<string, Record<string, unknown>>();
const postStart = new Map<string, number>();
const sourceFiles = Bun.spawnSync([
	"git",
	"ls-files",
	"-co",
	"--exclude-standard",
	"api/domains/larm",
	"api/domains/inference/service/errors.ts",
	"scripts/live-larm.ts",
	"scripts/larm-provider-readiness-live.ts",
])
	.stdout.toString()
	.trim()
	.split("\n");
const sourceHashes = Object.fromEntries(
	sourceFiles
		.filter((p) => p.endsWith(".ts"))
		.map((p) => [
			p,
			createHash("sha256").update(readFileSync(p)).digest("hex"),
		]),
);
const observe: typeof fetch = Object.assign(
	async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(String(input)),
			method = init?.method ?? "GET",
			begin = performance.now();
		const response = await fetch(input, init);
		if (/\/audio\/(speech|transcriptions)$/.test(url.pathname)) {
			audioCalls++;
			events.push({
				phase,
				operation: "audio_request",
				kind: url.pathname.endsWith("speech") ? "tts" : "asr",
				atMs: Math.round(begin - started),
				durationMs: Math.round(performance.now() - begin),
				status: response.status,
			});
		}
		if (
			url.pathname.startsWith("/v1/agent-connections") &&
			response.ok &&
			response.status !== 204
		) {
			const body = (await response.clone().json()) as Record<string, unknown>;
			if (
				typeof body.id !== "string" ||
				!/^[A-Za-z0-9_-]{1,160}$/.test(body.id)
			)
				throw new Error("invalid_test_connection_id");
			const id = body.id;
			if (method === "POST" && url.pathname === "/v1/agent-connections") {
				owned.set(id, JSON.parse(String(init?.body)));
				postStart.set(id, begin);
			}
			const providers = Array.isArray(body.providers)
				? (body.providers as Record<string, unknown>[])
				: [];
			events.push({
				phase,
				atMs: Math.round(begin - started),
				durationMs: Math.round(performance.now() - begin),
				operation: url.pathname.endsWith("/claim")
					? "claim"
					: url.pathname.endsWith("/renew")
						? "renew"
						: method === "POST"
							? "create"
							: "get",
				connectionId: id,
				status: body.status,
				connectionPhase: body.phase,
				providers: providers.map((p) => ({
					name: p.name,
					...(p.readiness ? { readiness: p.readiness } : {}),
				})),
				...(url.pathname.endsWith("/claim")
					? { selected: JSON.parse(String(init?.body)).providers }
					: {}),
				fromPostMs: Math.round(
					performance.now() - (postStart.get(id) ?? begin),
				),
			});
		}
		return response;
	},
	fetch,
);
async function control(path: string, body?: Record<string, unknown>) {
	const response = await observe(new URL(path, saved.baseUrl!), {
		method: body ? "POST" : "GET",
		redirect: "error",
		signal: AbortSignal.timeout(15_000),
		headers: {
			Authorization: `Bearer ${resolveLarmToken(process.env)}`,
			"Content-Type": "application/json",
			...(body && !path.endsWith("/claim")
				? { "Idempotency-Key": crypto.randomUUID() }
				: {}),
		},
		...(body ? { body: JSON.stringify(body) } : {}),
	});
	if (!response.ok) throw new Error(`control_${response.status}`);
	return response.json() as Promise<Record<string, unknown>>;
}
const main = createLiveLarm(process.env, { fetch: observe, keepAlive: true });
const background = createLiveLarm(process.env, {
	fetch: observe,
	keepAlive: true,
});
const voice = createLiveLarm(process.env, { fetch: observe });
const busyVoice = createLiveLarm(process.env, { fetch: observe });
const cancel = new AbortController();
const signal = () => AbortSignal.timeout(60_000);
const save = () =>
	writeFileSync(
		`${directory}/live.json`,
		JSON.stringify({ results, events, sourceHashes }, null, 2),
		{ mode: 0o600 },
	);
async function asr(port: typeof voice, audio: Uint8Array) {
	const begin = performance.now();
	const text = await port.transcribe(audio, AbortSignal.timeout(15_000));
	if (!text.trim()) throw new Error("synthetic_transcript_empty");
	results.push({
		phase,
		kind: "asr",
		durationMs: Math.round(performance.now() - begin),
		cloudFallback: false,
		lane: "real_larm_adapter",
		pass: true,
	});
	save();
}
async function speech(port = voice) {
	const begin = performance.now();
	const audio = await port.speak(
		"接続の確認です。今日もよろしくお願いします。",
		signal(),
	);
	results.push({
		phase,
		kind: "tts",
		durationMs: Math.round(performance.now() - begin),
		lane: "real_larm_adapter",
		pass: true,
	});
	await asr(port, audio);
}
let keepSlots: ReturnType<typeof setInterval> | undefined;
const heldSlots: string[] = [];
const retentionRequests = new Set<Promise<unknown>>();
try {
	const seed = await voice.speak("音声の接続を確認します。", signal());
	// A different port acquires ASR first on a new connection; the seed remains only in memory.
	await asr(busyVoice, seed);
	await speech(busyVoice);
	phase = "repeat_same_configuration";
	const voiceEntry = [...owned].find(([, body]) => !body.providers);
	if (!voiceEntry) throw new Error("owned_audio_scope_missing");
	const begin = performance.now(),
		repeat = await control("/v1/agent-connections", voiceEntry[1]);
	const audio = (repeat.providers as Record<string, unknown>[]).filter(
		(p) => p.name === "asr" || p.name === "tts",
	);
	const repeatMs = Math.round(performance.now() - begin);
	const repeatPass =
		repeat.id === voiceEntry[0] &&
		audio.length === 2 &&
		audio.every((p) => p.readiness === "ready") &&
		repeatMs <= 2000;
	results.push({
		phase,
		sameConnection: repeat.id === voiceEntry[0],
		durationMs: repeatMs,
		audioReadyRetained: audio.every((p) => p.readiness === "ready"),
		pass: repeatPass,
	});
	if (!repeatPass) throw new Error("repeat_readiness_failed");
	phase = "llm_generating";
	const began = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
	let active = 2;
	const work = [main, background].map((port, i) =>
		port.answerStream!(
			[
				{
					role: "user",
					content: "1から300までの整数を順に列挙してください。説明は不要です。",
				},
			],
			AbortSignal.any([cancel.signal, AbortSignal.timeout(120_000)]),
			() => began[i]!.resolve(),
			{ maxOutputTokens: 512 },
		)
			.then(
				() => ({ outcome: "completed" }),
				(error) => ({
					outcome: cancel.signal.aborted ? "cancelled_as_planned" : "failed",
					code: cancel.signal.aborted
						? "cancelled"
						: toErrorCode(error, "llm_failed"),
				}),
			)
			.finally(() => {
				active--;
			}),
	);
	let overlapTimer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			Promise.all(began.map((b) => b.promise)),
			new Promise(
				(_, reject) =>
					(overlapTimer = setTimeout(
						() => reject(new Error("generation_overlap_unconfirmed")),
						60_000,
					)),
			),
		]);
	} finally {
		clearTimeout(overlapTimer);
	}
	const activeAtStart = active;
	const generatingVoice = createLiveLarm(process.env, { fetch: observe });
	try {
		await asr(generatingVoice, seed);
		await speech(generatingVoice);
	} finally {
		await generatingVoice.close();
	}
	results.push({
		phase,
		bothProducedDelta: true,
		activeAtStart,
		activeAtEnd: active,
		pass: activeAtStart === 2 && active > 0,
	});
	cancel.abort();
	const llmOutcomes = await Promise.all(work);
	results.push({
		phase,
		llmOutcomes,
		pass: llmOutcomes.every((result) => result.outcome !== "failed"),
	});
	phase = "after_llm_cancel";
	await speech(busyVoice);
	phase = "kv_capacity";
	const firstLlm = [...owned.values()].find(
		(body) => Array.isArray(body.providers) && body.providers.includes("llm"),
	);
	if (!firstLlm) throw new Error("owned_llm_scope_missing");
	let full = false;
	for (let i = 0; i < 16; i++) {
		let state = await control("/v1/agent-connections", {
			...firstLlm,
			client: `eumenes-capacity-test-${crypto.randomUUID()}`,
		});
		heldSlots.push(String(state.id));
		for (
			let poll = 0;
			poll < 20 &&
			!["ready", "failed"].includes(String(state.status)) &&
			state.phase !== "waiting-capacity";
			poll++
		) {
			await new Promise((resolve) => setTimeout(resolve, 100));
			state = await control(`/v1/agent-connections/${state.id}`);
		}
		if (state.phase === "waiting-capacity") {
			full = true;
			break;
		}
	}
	results.push({
		phase,
		testConnectionsHeld: heldSlots.length,
		waitingCapacityObserved: full,
		pass: full,
	});
	if (!full) throw new Error("capacity_condition_unconfirmed");
	keepSlots = setInterval(() => {
		for (const id of heldSlots) {
			const body = owned.get(id);
			if (body) {
				const task = control("/v1/agent-connections", body).catch((error) => {
					results.push({
						phase: "slot_retention",
						pass: false,
						code: toErrorCode(error, "slot_retention_failed"),
					});
				});
				retentionRequests.add(task);
				void task.finally(() => retentionRequests.delete(task));
			}
		}
	}, 30_000);
	const saturatedVoice = createLiveLarm(process.env, { fetch: observe });
	try {
		await asr(saturatedVoice, seed);
		await speech(saturatedVoice);
	} finally {
		await saturatedVoice.close();
	}
	const unusedSince = Date.now(),
		beforeAudio = audioCalls;
	phase = "idle_10_minutes";
	results.push({
		phase,
		startedAt: new Date(unusedSince).toISOString(),
		status: "waiting",
	});
	save();
	console.log(JSON.stringify({ phase, status: "waiting", waitMs: 600_100 }));
	await new Promise((resolve) => setTimeout(resolve, 600_100));
	phase = "after_idle_10_minutes";
	results.push({
		phase,
		idleMs: Date.now() - unusedSince,
		ownedAudioRequestsDuringIdle: audioCalls - beforeAudio,
	});
	await asr(busyVoice, seed);
	await speech(busyVoice);
} catch (error) {
	results.push({ phase, pass: false, code: toErrorCode(error, "live_failed") });
	process.exitCode = 1;
} finally {
	clearInterval(keepSlots);
	cancel.abort();
	await Promise.allSettled(retentionRequests);
	const closes = await Promise.allSettled([
		main.close(),
		background.close(),
		voice.close(),
		busyVoice.close(),
	]);
	if (closes.some((result) => result.status === "rejected"))
		results.push({ phase: "close", pass: false });
	let confirmed = 0;
	for (const id of owned.keys()) {
		try {
			const response = await fetch(
				new URL(`/v1/agent-connections/${id}`, saved.baseUrl!),
				{
					method: "DELETE",
					redirect: "error",
					headers: { Authorization: `Bearer ${resolveLarmToken(process.env)}` },
					signal: AbortSignal.timeout(15_000),
				},
			);
			if ([200, 204, 404, 410].includes(response.status)) confirmed++;
			await response.body?.cancel();
		} catch {
			/* Every remaining owned connection still gets its cleanup attempt. */
		}
	}
	results.push({
		phase: "cleanup",
		ownedConnectionCount: owned.size,
		confirmed,
		pass: confirmed === owned.size,
	});
	if (results.some((row) => row.pass === false)) process.exitCode = 1;
	await flushLogging();
	save();
	console.log(JSON.stringify({ results, report: `${directory}/live.json` }));
}
