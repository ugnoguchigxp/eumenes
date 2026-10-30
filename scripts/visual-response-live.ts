import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	readStoredLarm,
	readStoredObjectRecognitionConnection,
} from "../api/domains/settings";
import { resolveLarmToken } from "../api/infrastructure/auth-config";
import { createVisualPerception } from "../api/domains/larm";
import type { StopObservation } from "../api/domains/larm/contracts/visual-perception";
import { imageForInput } from "../api/infrastructure/media-image";
import { waitFor } from "../api/infrastructure/wait-for";

if (!process.argv.includes("--run")) throw new Error("use --run");
const saved = readStoredLarm(
	process.env.EUMENES_DB || "./data/eumenes.sqlite3",
);
const token = resolveLarmToken(process.env);
if (!saved.baseUrl || !token)
	throw new Error("saved_larm_connection_unconfigured");
const out = resolve("verification-reports/visual-response-live");
mkdirSync(out, { recursive: true });
const report: {
	at: string;
	fixture: false;
	serverStarted: false;
	scenarios: unknown[];
	normal?: unknown;
} = {
	at: new Date().toISOString(),
	fixture: false,
	serverStarted: false,
	scenarios: [],
};
const save = () =>
	writeFileSync(`${out}/report.json`, JSON.stringify(report, null, 2));
const image = await imageForInput(
	new Uint8Array(
		await Bun.file(
			"spec/verification/object-recognition-live-2026-10-13/bus.jpg",
		).arrayBuffer(),
	),
	null,
	AbortSignal.timeout(30000),
	["image/png", "image/jpeg"],
	4194304,
	4194304,
);

for (const scenario of ["describe", "failure", "cancel"] as const) {
	const abort = new AbortController();
	const http: {
		path: string;
		method: string;
		status: number;
		requestId: string | null;
	}[] = [];
	const observations: StopObservation[] = [];
	let credential:
		| { endpoint: string; token: string; body?: string }
		| undefined;
	let connectionId: string | undefined;
	let inferenceStarted = false;
	const port = createVisualPerception({
		...saved,
		baseUrl: saved.baseUrl,
		token,
		fetch: (async (input, init = {}) => {
			const path = new URL(String(input)).pathname;
			if (path === "/v1/vision/perceive") {
				inferenceStarted = true;
				if (credential && typeof init.body === "string")
					credential.body = init.body;
				if (scenario === "cancel") setTimeout(() => abort.abort(), 300);
			}
			const response = await fetch(input, init);
			http.push({
				path,
				method: init.method ?? "GET",
				status: response.status,
				requestId: response.headers.get("x-request-id"),
			});
			if (path.endsWith("/claim") && response.status === 200) {
				const claim = await response.clone().json();
				const provider = claim.providers.find(
					(p: { protocol: string }) =>
						p.protocol === "larm.visual-perception.v1",
				);
				credential = {
					endpoint: provider.endpoint,
					token: provider.credential.token,
				};
			}
			return response;
		}) as typeof fetch,
	});
	let outcome: Record<string, unknown>;
	try {
		const result = await port.perceive(
			image,
			{
				task: scenario === "failure" ? "detection" : "describe",
				query: "画像の内容を簡潔に説明してください。",
			},
			AbortSignal.any([abort.signal, AbortSignal.timeout(330000)]),
			async (phase, id, observation) => {
				if (phase === "connection") connectionId = id;
				if (observation) observations.push(observation);
			},
		);
		if (scenario !== "describe")
			throw new Error("unexpected_inference_success");
		outcome = {
			accepted: true,
			nonemptyResponse: result.result.response.trim().length > 0,
			execution: result.result.execution,
			releaseConfirmed: result.releaseConfirmed,
		};
		// This is a validated test result artifact, kept apart from the diagnostic report.
		writeFileSync(
			`${out}/accepted-result.json`,
			JSON.stringify(result.result),
			{ mode: 0o600 },
		);
	} catch (error) {
		outcome = {
			accepted: false,
			cancelled: abort.signal.aborted,
			error:
				error instanceof Error && /^[a-z_0-9]+$/.test(error.message)
					? error.message
					: "request_aborted",
		};
		if (scenario === "describe") {
			report.scenarios.push({ scenario, outcome, http, observations });
			save();
			throw error;
		}
	}
	await waitFor(
		() => observations.some((value) => value.status !== "observing"),
		{ timeout: 35000, interval: 250 },
	);
	let revoked: { status: number; requestId: string | null } | undefined;
	if (credential?.body) {
		const response = await fetch(credential.endpoint, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${credential.token}`,
				"Content-Type": "application/json",
			},
			body: credential.body,
			signal: AbortSignal.timeout(15000),
		});
		revoked = {
			status: response.status,
			requestId: response.headers.get("x-request-id"),
		};
		await response.body?.cancel();
	}
	report.scenarios.push({
		scenario,
		connectionId,
		inferenceStarted,
		outcome,
		http,
		observations,
		revoked,
	});
	save();
	if (
		(scenario === "failure" && outcome.error !== "larm_http_400") ||
		!http.some((r) => r.method === "DELETE" && r.status === 204) ||
		!observations.some((o) => o.status === "cold") ||
		revoked?.status !== 401 ||
		(scenario === "cancel" && (!abort.signal.aborted || outcome.accepted))
	)
		throw new Error("live_lifecycle_unconfirmed");
	console.log(JSON.stringify({ scenario, outcome, revoked, cold: true }));
}

const normal = readStoredObjectRecognitionConnection(
	process.env.EUMENES_DB || "./data/eumenes.sqlite3",
);
const index = process.argv.indexOf("--recognition-url");
const normalUrl = index >= 0 ? process.argv[index + 1] : normal.baseUrl;
if (!normalUrl) throw new Error("recognition_connection_unconfigured");
const headers = { Authorization: `Bearer ${token}` };
const status = await fetch(new URL("/hosting/status", normalUrl), {
	headers,
	signal: AbortSignal.timeout(15000),
});
const statusHttp = status.status;
await status.body?.cancel();
const form = new FormData();
form.append(
	"file",
	new File([new Uint8Array(image.bytes)], "bus.jpg", { type: image.mime }),
);
const analyzed = await fetch(new URL("/api/analyze", normalUrl), {
	method: "POST",
	headers,
	body: form,
	signal: AbortSignal.timeout(120000),
});
report.normal = {
	savedEndpointMatches: normal.baseUrl === normalUrl,
	credentialSource: normal.credentialSource,
	statusHttp,
	analyzeHttp: analyzed.status,
	requestId: analyzed.headers.get("x-request-id"),
};
await analyzed.body?.cancel();
save();
if (statusHttp !== 200 || analyzed.status !== 200)
	throw new Error("normal_detection_unconfirmed");
console.log(JSON.stringify({ normal: report.normal }));
