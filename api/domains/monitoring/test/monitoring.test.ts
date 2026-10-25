import { expect, test } from "bun:test";
import { createActivityRecorder, type LarmStatus } from "../../larm";
import type { Settings } from "../../settings/contracts";
import { createMonitoring, type MonitoringDeps } from "../service";
import {
	createHostMetrics,
	parseVmStat,
	type HostProbes,
} from "../service/host";
import { serviceState } from "../service/rules";

const idle = { running: 0, lastSuccessAt: null, lastFailure: null };
const resourceId = "00000000-0000-4000-8000-000000000001";
const connectionId = "00000000-0000-4000-8000-000000000002";

function settings(llm: Partial<Settings["routes"]["llm"]> = {}): Settings {
	const route = {
		mode: "larm-preferred" as const,
		cloudAllowed: false,
		fallbackId: null,
		epoch: 0,
	};
	return {
		routes: { llm: { ...route, ...llm }, asr: route, tts: route },
		resources: [{ id: resourceId, connectionId, purpose: "llm" }],
		connections: [{ id: connectionId, enabled: true }],
	} as unknown as Settings;
}

function probes(over: Partial<HostProbes> = {}): HostProbes {
	let cpu = 0;
	let own = 0;
	return {
		cpuTimes: () => ((cpu += 100), { idle: cpu * 0.5, total: cpu }),
		availableMemory: async () => 600,
		totalMemory: () => 1000,
		disk: async () => ({ used: 0.5 }),
		processCpu: () => (
			(own += 1),
			{ cpuMicros: own * 250_000, atMs: own * 1000 }
		),
		...over,
	};
}

function monitoring(over: Partial<MonitoringDeps> = {}, host = probes()) {
	const status: LarmStatus = { state: "ready", capabilities: [] };
	return createMonitoring({
		settings: {
			get: () => settings(),
			diagnostics: () => ({
				connections: [{ id: connectionId, credentialAvailable: true }],
			}),
		},
		larmStatus: () => status,
		attempts: () => ({ llm: idle, asr: idle, tts: idle }),
		embedding: createActivityRecorder(),
		judge: createActivityRecorder(),
		queue: {
			stats: () => ({
				lanes: {
					interactive: { queued: 0, running: 0, failed: 0, oldestWaitMs: null },
				},
				resources: {},
				openJobs: 0,
				lastScanAt: null,
			}),
		},
		dataDir: "/data",
		host: createHostMetrics("/data", host),
		now: () => 1_000_000,
		...over,
	});
}
const byShape = async (m: ReturnType<typeof monitoring>) =>
	Object.fromEntries((await m.snapshot()).items.map((i) => [i.shape, i]));

test("a service is healthy, faulty or disconnected by its newest outcome", () => {
	expect(serviceState({ ...idle, lastSuccessAt: 5 }, true).health).toBe(
		"healthy",
	);
	expect(serviceState(idle, true).health).toBe("unknown");
	expect(
		serviceState(
			{ ...idle, lastSuccessAt: 5, lastFailure: { at: 6, reason: "x_bad" } },
			true,
		),
	).toEqual({ health: "fault", activity: "idle", reason: "x_bad" });
	// Not reaching the service is a disconnection, never a fault (Q6).
	expect(
		serviceState(
			{ ...idle, lastFailure: { at: 6, reason: "network_unavailable" } },
			true,
		).health,
	).toBe("disconnected");
	expect(
		serviceState(
			{ ...idle, lastSuccessAt: 7, lastFailure: { at: 6, reason: "x_bad" } },
			true,
		).health,
	).toBe("healthy");
	expect(serviceState({ ...idle, running: 1 }, false)).toEqual({
		health: "disconnected",
		activity: "working",
	});
	expect(serviceState(idle, true, true).activity).toBe("starting");
});

test("LARM down disconnects LARM routes, while a usable cloud route keeps them reachable", async () => {
	const failed: LarmStatus = { state: "failed", capabilities: [] };
	let m = monitoring({ larmStatus: () => failed });
	let items = await byShape(m);
	for (const shape of ["llm", "asr", "embedding", "attitude", "image", "music"])
		expect(items[shape]?.state.health).toBe("disconnected");
	m = monitoring({
		larmStatus: () => failed,
		settings: {
			get: () => settings({ mode: "cloud-only", fallbackId: resourceId }),
			diagnostics: () => ({
				connections: [{ id: connectionId, credentialAvailable: true }],
			}),
		},
	});
	items = await byShape(m);
	expect(items.llm?.state.health).toBe("unknown");
	expect(items.asr?.state.health).toBe("disconnected");
	m = monitoring({
		settings: {
			get: () => settings({ mode: "cloud-only", fallbackId: resourceId }),
			diagnostics: () => ({
				connections: [{ id: connectionId, credentialAvailable: false }],
			}),
		},
	});
	expect((await byShape(m)).llm?.state.health).toBe("disconnected");
});

test("off the LAN, LARM not answering is unknown; a cloud route without credential is still disconnected", async () => {
	const failed: LarmStatus = { state: "failed", capabilities: [] };
	let items = await byShape(
		monitoring({ larmStatus: () => failed, onLan: async () => false }),
	);
	for (const shape of ["llm", "asr", "embedding", "attitude", "image", "music"])
		expect(items[shape]?.state).toMatchObject({
			health: "unknown",
			reason: "larm_off_lan",
		});
	items = await byShape(
		monitoring({
			onLan: async () => false,
			settings: {
				get: () => settings({ mode: "cloud-only", fallbackId: resourceId }),
				diagnostics: () => ({
					connections: [{ id: connectionId, credentialAvailable: false }],
				}),
			},
		}),
	);
	expect(items.llm?.state.health).toBe("disconnected");
	items = await byShape(
		monitoring({ larmStatus: () => failed, onLan: async () => true }),
	);
	expect(items.llm?.state.health).toBe("disconnected");
});

test("recorded outcomes count only inside the ten-minute window", async () => {
	let clock = 0;
	const judge = createActivityRecorder(() => clock);
	await judge.track(async () => {});
	const m = monitoring({ judge, now: () => clock });
	expect((await byShape(m)).attitude?.state.health).toBe("healthy");
	clock = 10 * 60_000 + 1;
	expect((await byShape(m)).attitude?.state.health).toBe("unknown");
});

test("host thresholds and the backend's load and activity", async () => {
	let m = monitoring();
	let items = await byShape(m);
	expect(items.cpu?.state).toEqual({
		health: "healthy",
		activity: "idle",
		utilization: 0.5,
	});
	expect(items.memory?.state.utilization).toBeCloseTo(0.4);
	expect(items.ssd?.state.health).toBe("healthy");
	expect(items.network).toEqual({
		id: "eumenes-backend",
		shape: "network",
		label: "Eumenes Backend",
		state: { health: "healthy", activity: "idle", utilization: 0.25 },
	});
	m = monitoring(
		{
			attempts: () => ({
				llm: { ...idle, running: 1 },
				asr: idle,
				tts: idle,
			}),
		},
		probes({
			cpuTimes: (() => {
				let n = 0;
				return () => ((n += 100), { idle: n * 0.1, total: n });
			})(),
			availableMemory: async () => 50,
			disk: async () => ({ used: 0.98 }),
		}),
	);
	items = await byShape(m);
	expect(items.cpu?.state.health).toBe("pressure");
	expect(items.memory?.state.health).toBe("pressure");
	expect(items.ssd?.state.health).toBe("fault");
	expect(items.network?.state.activity).toBe("working");
	expect(items.llm?.state.activity).toBe("working");
	m = monitoring(
		{},
		probes({ availableMemory: () => Promise.reject(new Error("no vm_stat")) }),
	);
	expect((await byShape(m)).memory?.state).toEqual({
		health: "unknown",
		activity: "idle",
	});
});

test("vm_stat counts free, inactive and speculative pages as available", () => {
	expect(
		parseVmStat(
			[
				"Mach Virtual Memory Statistics: (page size of 16384 bytes)",
				"Pages free:                                    10.",
				"Pages active:                                  99.",
				"Pages inactive:                                20.",
				"Pages speculative:                              2.",
			].join("\n"),
		),
	).toBe(16384 * 32);
	expect(parseVmStat("unexpected")).toBeNull();
});

test("a timeout reached the service: it is a fault, not a disconnection", () => {
	expect(
		serviceState(
			{ ...idle, lastFailure: { at: 6, reason: "local_timeout" } },
			true,
		).health,
	).toBe("fault");
});

test("a cloud-only route does not show LARM's connection as starting", async () => {
	const connecting: LarmStatus = { state: "connecting", capabilities: [] };
	const m = monitoring({
		larmStatus: () => connecting,
		settings: {
			get: () => settings({ mode: "cloud-only", fallbackId: resourceId }),
			diagnostics: () => ({
				connections: [{ id: connectionId, credentialAvailable: true }],
			}),
		},
	});
	const items = await byShape(m);
	expect(items.llm?.state.activity).toBe("idle");
	expect(items.asr?.state.activity).toBe("starting");
});

test("concurrent reads share one host sample instead of measuring a tiny window", async () => {
	let clock = 0;
	let reads = 0;
	const host = createHostMetrics(
		"/data",
		probes({ availableMemory: async () => (reads++, 600) }),
		() => clock,
	);
	const [a, b] = await Promise.all([host.sample(), host.sample()]);
	expect(a).toBe(b);
	expect(reads).toBe(1);
	clock = 2000;
	await host.sample();
	expect(reads).toBe(2);
});
