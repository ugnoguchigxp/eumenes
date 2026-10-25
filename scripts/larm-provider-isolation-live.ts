import { mkdirSync, writeFileSync } from "node:fs";
import { createLiveLarm } from "./live-larm";
import { configureLogging, flushLogging } from "../api/infrastructure/logger";
import { safeError } from "../api/domains/inference/service/errors";
import { toErrorCode } from "../api/infrastructure/error-code";

/** Controlled faults at the consumer transport boundary, with real audio and real claims. No Provider is stopped. */
if (!process.argv.includes("--run")) throw new Error("live_requires_run");
const directory = `verification-reports/larm-provider-readiness-2026-10-25/review-isolation/${new Date().toISOString().replaceAll(":", "-")}`;
mkdirSync(directory, { recursive: true, mode: 0o700 });
configureLogging({
	file: `${directory}/adapter.jsonl`,
	destination: { write() {} },
});
const results: Record<string, unknown>[] = [];
for (const mode of [
	"llm_failed",
	"asr_failed",
	"asr_timeout",
	"cancel_late_asr",
	"credential_rotation",
	"asr_idle_release",
	"asr_credential_expired",
	"asr_cached_failure",
] as const) {
	let deleted = 0,
		renews = 0;
	const claims: string[][] = [];
	const shortened = new Set<string>();
	const arrived = Promise.withResolvers<void>(),
		release = Promise.withResolvers<void>();
	let pendingLate = false,
		idleRejected = false,
		cachedFailure = false;
	const observer: typeof fetch = Object.assign(
		async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = new URL(String(input));
			if (init?.method === "DELETE") deleted++;
			if (url.pathname.endsWith("/renew")) renews++;
			if (
				mode === "asr_idle_release" &&
				url.pathname.endsWith("audio/transcriptions") &&
				!idleRejected
			) {
				idleRejected = true;
				return Response.json(
					{ error: { code: "connection_idle_released" } },
					{ status: 409 },
				);
			}
			const response = await fetch(input, init);
			if (url.pathname.endsWith("audio/transcriptions") && pendingLate) {
				// The real response arrived; hold only its delivery to test adoption after cancellation.
				arrived.resolve();
				await release.promise;
			}
			if (
				!url.pathname.startsWith("/v1/agent-connections") ||
				response.status === 204 ||
				!response.ok
			)
				return response;
			const body = (await response.clone().json()) as Record<string, unknown>;
			if (url.pathname.endsWith("/claim")) {
				const selected: string[] = JSON.parse(String(init?.body)).providers;
				claims.push(selected);
				if (
					(mode === "asr_credential_expired" ||
						(mode === "asr_cached_failure" && !cachedFailure)) &&
					selected.includes("asr")
				) {
					body.expiresAt = new Date(
						Date.now() + (mode === "asr_cached_failure" ? 60_000 : 1000),
					).toISOString();
					return Response.json(body, { status: response.status });
				}
				if (
					mode === "credential_rotation" &&
					selected.some((n) => !shortened.has(n))
				) {
					for (const n of selected) shortened.add(n);
					// Shorten only the consumer's advertised lifetime. The actual signed credentials and renew are real.
					body.expiresAt = new Date(Date.now() + 60_000).toISOString();
					return Response.json(body, { status: response.status });
				}
				return response;
			}
			if (init?.method === "GET" && Array.isArray(body.providers)) {
				if (mode === "llm_failed") {
					body.status = "failed";
					for (const p of body.providers as Record<string, unknown>[])
						if (p.name === "llm") p.readiness = "failed";
				}
				if (
					mode === "asr_failed" ||
					mode === "asr_timeout" ||
					(mode === "asr_cached_failure" && cachedFailure)
				) {
					body.status = mode === "asr_timeout" ? "probing" : "failed";
					for (const p of body.providers as Record<string, unknown>[])
						if (p.name === "asr")
							p.readiness = mode === "asr_timeout" ? "probing" : "failed";
				}
				return Response.json(body, { status: response.status });
			}
			return response;
		},
		fetch,
	);
	const port = createLiveLarm(process.env, { fetch: observer });
	const limit = () => AbortSignal.timeout(60_000);
	let pass = false;
	try {
		const seed = await port.speak("これは音声接続の確認です。", limit());
		let code: string | undefined,
			adopted = false;
		const started = performance.now();
		if (mode === "cancel_late_asr") {
			pendingLate = true;
			const caller = new AbortController();
			const work = port.transcribe(seed, caller.signal).then(
				() => {
					adopted = true;
				},
				(error) => {
					code = toErrorCode(error, "cancelled");
				},
			);
			await arrived.promise;
			caller.abort();
			release.resolve();
			await work;
		} else {
			try {
				const text = await port.transcribe(
					seed,
					mode === "asr_timeout" ? AbortSignal.timeout(15_000) : limit(),
				);
				adopted = !!text.trim();
			} catch (error) {
				code = safeError(error, new AbortController().signal);
			}
		}
		if (mode === "asr_cached_failure") {
			if (!adopted) throw new Error("cached_asr_setup_failed");
			cachedFailure = true;
			try {
				await port.prepareVoice!(limit());
			} catch (error) {
				adopted = false;
				code = safeError(error, new AbortController().signal);
			}
		}
		const asrMs = Math.round(performance.now() - started);
		if (mode === "credential_rotation") {
			if (!(await port.transcribe(seed, limit())).trim())
				throw new Error("renewed_asr_empty");
		}
		const tts = await port.speak("文字起こしと別に音声を確認します。", limit());
		pass =
			(mode === "llm_failed" ||
			mode === "credential_rotation" ||
			mode === "asr_idle_release"
				? adopted
				: !adopted) &&
			tts.length > 44 &&
			deleted === 0 &&
			(mode !== "asr_cached_failure" ||
				!port.status().capabilities.includes("asr")) &&
			(mode !== "credential_rotation" || renews > 0) &&
			(mode !== "asr_timeout" || asrMs >= 14_900);
		results.push({
			mode,
			lane: "real_connection_with_controlled_consumer_fault",
			faultAt:
				mode === "credential_rotation" || mode === "asr_credential_expired"
					? "advertised_expiry_shortened"
					: mode === "cancel_late_asr"
						? "response_delivery"
						: mode === "asr_idle_release"
							? "inference_rejection"
							: "get_readiness",
			asrMs,
			adopted,
			...(code ? { code } : {}),
			ttsSucceeded: tts.length > 44,
			deletesBeforeClose: deleted,
			renews,
			claims,
			pass,
		});
	} catch (error) {
		results.push({
			mode,
			pass: false,
			code: toErrorCode(error, "isolation_failed"),
		});
	} finally {
		release.resolve();
		await port.close();
	}
	if (!pass) process.exitCode = 1;
}
await flushLogging();
writeFileSync(`${directory}/live.json`, JSON.stringify(results, null, 2), {
	mode: 0o600,
});
console.log(JSON.stringify({ results, report: `${directory}/live.json` }));
