import { mkdirSync, writeFileSync } from "node:fs";
import { readApiToken } from "../api/infrastructure/auth-config";
import { loadProcessConfig } from "../api/infrastructure/config";
import { toErrorCode } from "../api/infrastructure/error-code";
import {
	createLogReader,
	defaultLogFile,
} from "../api/infrastructure/log-reader";

/** Uses the running API, its saved routing and synthetic sample; never starts/stops a server. */
if (!process.argv.includes("--run"))
	throw new Error("deployment_check_requires_run");
const config = loadProcessConfig();
const token = readApiToken(process.env, config.dbPath);
const base = `http://${config.host}:${config.port}`;
const sessionId = crypto.randomUUID(),
	utteranceId = crypto.randomUUID();
const report: Record<string, unknown> = {
	lane: "running_production_api_synthetic_no_devices",
};
const ids = new Set<string>();
const directory =
	"verification-reports/larm-provider-readiness-2026-10-25/deployment";
mkdirSync(directory, { recursive: true, mode: 0o700 });
async function request(path: string, body?: BodyInit, headers?: HeadersInit) {
	const begin = performance.now();
	const response = await fetch(`${base}${path}`, {
		method: body ? "POST" : "GET",
		redirect: "error",
		body,
		headers: { Authorization: `Bearer ${token}`, ...headers },
		signal: AbortSignal.timeout(60_000),
	});
	const id = response.headers.get("X-Request-Id");
	if (id) ids.add(id);
	if (!response.ok) throw new Error(`api_http_${response.status}`);
	return {
		response,
		durationMs: Math.round(performance.now() - begin),
		httpRequestId: id,
	};
}
const post = (path: string, body: unknown) =>
	request(path, JSON.stringify(body), { "Content-Type": "application/json" });
let opened = false;
try {
	const status = await request("/api/status");
	const service = (await status.response.json()) as { service?: string };
	if (service.service !== "eumenes") throw new Error("unexpected_api_service");
	report.serviceAvailable = true;
	const started = await post("/api/voice/sessions", {
		sessionId,
		generation: 1,
	});
	opened = true;
	report.sessionStartMs = started.durationMs;
	const sample = await post("/api/voice/sample", {});
	const wav = new Uint8Array(await sample.response.arrayBuffer());
	if (wav.length <= 44) throw new Error("synthetic_sample_empty");
	report.tts = {
		durationMs: sample.durationMs,
		httpRequestId: sample.httpRequestId,
		pass: true,
	};
	const recognition = await request("/api/voice/preview", wav, {
		"Content-Type": "audio/wav",
		"X-Session-Id": sessionId,
		"X-Generation": "1",
		"X-Sequence": "1",
		"X-Utterance-Id": utteranceId,
	});
	const transcript = (await recognition.response.json()) as { text?: string };
	if (!transcript.text?.trim()) throw new Error("synthetic_transcript_empty");
	report.asr = {
		durationMs: recognition.durationMs,
		httpRequestId: recognition.httpRequestId,
		pass: true,
	};
	report.pass = true;
} catch (error) {
	report.pass = false;
	report.code = toErrorCode(error, "deployment_check_failed");
	process.exitCode = 1;
} finally {
	if (opened) {
		try {
			await post("/api/voice/sessions/stop", { sessionId, generation: 1 });
			report.testSessionStopped = true;
		} catch {
			report.testSessionStopped = false;
			report.pass = false;
			process.exitCode = 1;
		}
	}
	let attempts: Record<string, unknown>[] = [];
	const logFile = config.logFile ?? defaultLogFile();
	const succeeded = (purpose: string) =>
		attempts.find(
			(e) => e.event === "inference.attempt_succeeded" && e.purpose === purpose,
		);
	if (logFile) {
		const deadline = Date.now() + 2000;
		for (;;) {
			attempts = [];
			try {
				await createLogReader(logFile).read((entry) => {
					if (!ids.has(String(entry.httpRequestId ?? ""))) return;
					if (
						[
							"inference.attempt_started",
							"inference.attempt_failed",
							"inference.attempt_succeeded",
							"inference.cloud_selected",
						].includes(String(entry.event))
					)
						attempts.push({
							event: entry.event,
							purpose: entry.purpose,
							source: entry.source,
							reason: entry.reason,
							durationMs: entry.durationMs,
							pid: entry.pid,
							bootId: entry.bootId,
						});
				});
			} catch {
				report.logReadError = "log_unavailable";
				break;
			}
			if (
				(succeeded("asr") && succeeded("tts")) ||
				report.pass !== true ||
				Date.now() >= deadline
			)
				break;
			await Bun.sleep(100);
		}
	}
	report.attempts = attempts;
	report.asrCloudFallback = succeeded("asr")
		? attempts.some((e) => e.purpose === "asr" && e.source === "cloud")
		: null;
	report.larmRouteConfirmed =
		succeeded("asr")?.source === "larm" && succeeded("tts")?.source === "larm";
	if (report.pass === true && !report.larmRouteConfirmed) {
		report.pass = false;
		report.code = "provider_route_unconfirmed";
	}
	if (report.pass !== true) process.exitCode = 1;
	writeFileSync(`${directory}/live.json`, JSON.stringify(report, null, 2), {
		mode: 0o600,
	});
	console.log(JSON.stringify(report));
}
