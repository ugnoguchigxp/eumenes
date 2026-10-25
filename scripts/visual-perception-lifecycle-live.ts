import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { liveLarmSettings } from "./live-larm";
import { resolveLarmToken } from "../api/infrastructure/auth-config";
import { createVisualPerception } from "../api/domains/larm";
import { imageForInput } from "../api/infrastructure/media-image";
if (!process.argv.includes("--run")) throw new Error("use --run");
const saved = liveLarmSettings(),
	token = resolveLarmToken(process.env);
if (!saved.baseUrl || !token)
	throw new Error("saved_larm_connection_unconfigured");
const out = resolve("spec/verification/visual-perception-2026-10-25");
mkdirSync(out, { recursive: true });
const report: {
	at: string;
	idle?: unknown;
	cancel?: unknown;
	reuse?: unknown;
	failure?: string;
} = { at: new Date().toISOString() };
const save = () =>
	writeFileSync(`${out}/live-lifecycle.json`, JSON.stringify(report, null, 2));
const port = createVisualPerception({
	...saved,
	baseUrl: saved.baseUrl,
	token,
});
async function control(path: string, init: RequestInit = {}) {
	const r = await fetch(new URL(path, saved.baseUrl!), {
		...init,
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
			...init.headers,
		},
		redirect: "error",
		signal: AbortSignal.timeout(15000),
	});
	if (![200, 201, 202, 204, 404].includes(r.status))
		throw new Error(`control_${r.status}`);
	return r.status === 204 || r.status === 404
		? { status: r.status === 404 ? "not_found" : "released" }
		: ((await r.json()) as Record<string, unknown>);
}
let connection: string | undefined;
try {
	const target = await port.discover(AbortSignal.timeout(30000));
	const start = performance.now();
	let state = await control("/v1/agent-connections", {
		method: "POST",
		headers: { "Idempotency-Key": crypto.randomUUID() },
		body: JSON.stringify({
			profile: target.selector,
			expectedCatalogRevision: target.revision,
			audience: saved.audience,
			client: `eumenes-idle-check-${crypto.randomUUID()}`,
			providers: [target.name],
			ttlSeconds: 600,
			allowFallback: false,
			deploymentPolicy: "existing-only",
		}),
	});
	connection = String(state.id);
	while (state.status !== "ready") {
		if (
			performance.now() - start > 120000 ||
			["failed", "released", "expired"].includes(String(state.status))
		)
			throw new Error("connection_not_ready");
		await Bun.sleep(1000);
		state = await control(
			`/v1/agent-connections/${encodeURIComponent(connection)}`,
		);
	}
	await control(
		`/v1/agent-connections/${encodeURIComponent(connection)}/claim`,
		{ method: "POST", body: JSON.stringify({ format: "openai-provider-v1" }) },
	);
	const claimedAt = performance.now();
	console.log("idle_observation_started");
	while (!["released", "expired", "not_found"].includes(String(state.status))) {
		if (performance.now() - claimedAt > 100000)
			throw new Error("idle_release_unconfirmed");
		await Bun.sleep(5000);
		state = await control(
			`/v1/agent-connections/${encodeURIComponent(connection)}`,
		);
	}
	report.idle = {
		connectionId: connection,
		claimWaitingMs: claimedAt - start,
		observationMs: performance.now() - claimedAt,
		state: state.status,
		inferenceRequests: 0,
	};
	save();
	console.log("idle_release_confirmed");
} catch (error) {
	report.failure = error instanceof Error ? error.message : "failed";
	save();
	throw error;
} finally {
	if (connection) await port.release(connection);
}
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
const abort = new AbortController();
let cancelledConnection: string | undefined;
let released = false;
try {
	await port.perceive(
		image,
		{ task: "describe", query: "この画像を説明してください。" },
		abort.signal,
		async (phase, id) => {
			if (phase === "connection") cancelledConnection = id;
			if (phase === "running") abort.abort();
			if (phase === "released") released = true;
		},
	);
	throw new Error("cancel_not_applied");
} catch (error) {
	if (!abort.signal.aborted) throw error;
	report.cancel = {
		connectionId: cancelledConnection,
		aborted: true,
		releaseConfirmed: released,
	};
	save();
	if (!released) throw new Error("cancel_release_unconfirmed");
	console.log("cancel_release_confirmed");
}
const reused = await port.perceive(
	image,
	{ task: "referring", query: "バス" },
	AbortSignal.timeout(340000),
	async () => {},
);
report.reuse = {
	task: reused.result.task,
	detections: reused.result.detections.length,
	releaseConfirmed: reused.releaseConfirmed,
	elapsedMs: reused.elapsedMs,
};
save();
console.log("reuse_confirmed");
