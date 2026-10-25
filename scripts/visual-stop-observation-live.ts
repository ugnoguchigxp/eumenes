import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { liveLarmSettings } from "./live-larm";
import { resolveLarmToken } from "../api/infrastructure/auth-config";
import { createVisualPerception } from "../api/domains/larm";
import type { StopObservation } from "../api/domains/larm/contracts/visual-perception";
import { imageForInput } from "../api/infrastructure/media-image";
import { waitFor } from "../api/infrastructure/wait-for";
if (!process.argv.includes("--run")) throw new Error("use --run");
const saved = liveLarmSettings(),
	token = resolveLarmToken(process.env);
if (!saved.baseUrl || !token)
	throw new Error("saved_larm_connection_unconfigured");
const baseUrl = saved.baseUrl;
const out = resolve("spec/verification/visual-stop-observation-2026-10-25");
mkdirSync(out, { recursive: true });
const report: {
	at: string;
	stateHttp?: number;
	phases: unknown[];
	observations: StopObservation[];
	cancel?: unknown;
	reuse?: unknown;
	delayedClaim?: unknown;
	failure?: string;
} = { at: new Date().toISOString(), phases: [], observations: [] };
const save = () =>
	writeFileSync(`${out}/live.json`, JSON.stringify(report, null, 2));
let delayed = false;
const fetcher = (async (input, init) => {
	const url = new URL(String(input));
	if (delayed && url.pathname.endsWith("/claim")) {
		delayed = false;
		await Bun.sleep(11000);
		const stateResponse = await fetch(
			new URL(url.pathname.replace(/\/claim$/, ""), baseUrl),
			{
				headers: { Authorization: `Bearer ${token}` },
				cache: "no-store",
				signal: init?.signal,
			},
		);
		const state = (await stateResponse.json()) as {
			status?: string;
			providers?: { claimable?: boolean; readiness?: string }[];
		};
		report.delayedClaim = {
			at: new Date().toISOString(),
			delayMs: 11000,
			httpStatus: stateResponse.status,
			status: state.status,
			providers: state.providers?.map((p) => ({
				claimable: p.claimable,
				readiness: p.readiness,
			})),
		};
		save();
	}
	const response = await fetch(input, init);
	if (url.pathname.endsWith("/claim")) {
		report.phases.push({
			at: new Date().toISOString(),
			phase: "claim",
			httpStatus: response.status,
		});
		save();
	}
	return response;
}) as typeof fetch;
const port = createVisualPerception({
	...saved,
	baseUrl: baseUrl,
	token,
	fetch: fetcher,
});
const image = await imageForInput(
	new Uint8Array(
		await Bun.file(
			resolve("spec/verification/object-recognition-live-2026-10-13/bus.jpg"),
		).arrayBuffer(),
	),
	null,
	AbortSignal.timeout(30000),
	["image/png", "image/jpeg"],
	4194304,
	4194304,
);
const progress = async (phase: string, id?: string, o?: StopObservation) => {
	report.phases.push({
		at: new Date().toISOString(),
		phase,
		...(id ? { connectionId: id } : {}),
	});
	if (o) report.observations.push(o);
	save();
	console.log(
		JSON.stringify({
			phase,
			...(id ? { connectionId: id } : {}),
			...(o ? { observation: o.status } : {}),
		}),
	);
};
try {
	const state = await fetch(new URL("/state", baseUrl), {
		headers: { Authorization: `Bearer ${token}` },
		cache: "no-store",
		signal: AbortSignal.timeout(15000),
	});
	report.stateHttp = state.status;
	await state.body?.cancel();
	save();
	if (state.status !== 200) throw new Error(`state_${state.status}`);
	const abort = new AbortController();
	let connection: string | undefined;
	try {
		await port.perceive(
			image,
			{ task: "describe", query: "この画像を説明してください。" },
			abort.signal,
			async (phase, id, o) => {
				if (phase === "connection") connection = id;
				await progress(phase, id, o);
				if (phase === "running") abort.abort();
			},
		);
		throw new Error("cancel_not_applied");
	} catch (error) {
		if (!abort.signal.aborted) throw error;
	}
	report.cancel = {
		at: new Date().toISOString(),
		connectionId: connection,
		cancelled: true,
		beforeInference: true,
	};
	save();
	// No COLD wait: start a fresh operation immediately after cancellation cleanup.
	const result = await port.perceive(
		image,
		{ task: "referring", query: "バス" },
		AbortSignal.timeout(340000),
		progress,
	);
	report.reuse = {
		at: new Date().toISOString(),
		elapsedMs: result.elapsedMs,
		waitingMs: result.waitingMs,
		releaseConfirmed: result.releaseConfirmed,
		detections: result.result.detections.length,
	};
	save();
	await waitFor(
		() =>
			report.observations.filter((o) => o.status !== "observing").length >= 2,
		{ timeout: 35000, interval: 250 },
	);
	delayed = true;
	const cached = await port.perceive(
		image,
		{ task: "describe", query: "画像を短く説明してください。" },
		AbortSignal.timeout(340000),
		progress,
	);
	report.delayedClaim = {
		...(report.delayedClaim as object),
		succeeded: true,
		elapsedMs: cached.elapsedMs,
		releaseConfirmed: cached.releaseConfirmed,
	};
	save();
	await waitFor(
		() =>
			report.observations.filter((o) => o.status !== "observing").length >= 3,
		{ timeout: 35000, interval: 250 },
	);
	if (!report.observations.some((o) => o.status === "cold"))
		throw new Error("fresh_cold_unconfirmed");
} catch (error) {
	report.failure =
		error instanceof Error && /^[A-Za-z0-9_]+$/.test(error.message)
			? error.message
			: "live_check_failed";
	save();
	throw new Error(report.failure);
}
save();
console.log("live_stop_observation_passed");
