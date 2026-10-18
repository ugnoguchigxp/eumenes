import { expect, test } from "bun:test";
import { createApp } from "./app";
import { createMonitoring, registerMonitoring } from "../domains/monitoring";
import { defaults } from "../domains/settings";
import { createActivityRecorder } from "../domains/larm";
import { monitoringSnapshotSchema } from "../domains/monitoring/contracts";
import { collectorHarness } from "../domains/monitoring/test/larm.fixture";

test("the authenticated product snapshot combines the original services and LARM through the canonical boundary", async () => {
	const h = collectorHarness(),
		settings = defaults({}),
		idle = { running: 0, lastSuccessAt: null, lastFailure: null };
	const service = createMonitoring({
		remote: h.collector,
		settings: { get: () => settings, diagnostics: () => ({ connections: [] }) },
		larmStatus: () => ({ state: "ready", capabilities: [] }),
		attempts: () => ({ llm: idle, asr: idle, tts: idle, language: idle }),
		embedding: createActivityRecorder(),
		judge: createActivityRecorder(),
		queue: {
			stats: () => ({
				lanes: {},
				resources: {},
				openJobs: 0,
				lastScanAt: null,
			}),
		},
		dataDir: "unused",
		host: {
			sample: async () => ({ cpu: 0, memory: 0.5, disk: 0.6, process: 0 }),
		},
		now: h.now,
	});
	const token = "fixture-product-auth-credential";
	const app = createApp({
		token,
		origin: "http://127.0.0.1:5173",
		modules: [{ mount: (app) => registerMonitoring(app, service) }],
	});
	expect((await app.request("/api/monitoring/snapshot")).status).toBe(401);
	const response = await app.request("/api/monitoring/snapshot", {
		headers: { Authorization: `Bearer ${token}` },
	});
	expect(response.status).toBe(200);
	expect(response.headers.get("X-Request-Id")).toBeTruthy();
	const snapshot = monitoringSnapshotSchema.parse(await response.json());
	expect(snapshot.items).toHaveLength(16);
	expect(snapshot.items.find((i) => i.shape === "cpu")?.state.utilization).toBe(
		0,
	);
	expect(
		snapshot.items.find((i) => i.shape === "larm-cpu")?.state.utilization,
	).toBeDefined();
	expect(snapshot.larm?.history.results.cancelled).toBe("1");
	expect(JSON.stringify(snapshot)).not.toContain("existing-control-canary");
	await service.close();
});
