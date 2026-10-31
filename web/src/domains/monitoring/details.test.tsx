import { expect, test } from "vitest";
import type {
	MonitoringItem,
	MonitoringSnapshot,
} from "../../../../api/domains/monitoring/contracts";
import {
	emptyLarm,
	larmViewSchema,
} from "../../../../api/domains/monitoring/contracts/larm";
import { monitoringDetails } from "./details";
import { monitoringItems, STALE_AFTER_MS } from "./items";

const now = Date.now();
const state = (count = 3): MonitoringItem["state"] => ({
	health: "healthy",
	activity: "idle",
	stale: true,
	utilization: 1,
	observations: Array.from({ length: count }, () => ({
		status: "ok",
		observedAt: now - 47000,
		ageMs: 47000,
		maxAgeMs: 10000,
	})),
	diagnostics: ["ok", "ok", "history_incomplete"],
});
function snapshot(s = state()): MonitoringSnapshot {
	const larm = larmViewSchema.parse({
		...emptyLarm(now),
		snapshotReceivedAt: now - 47000,
		snapshotStatus: { status: "ok", at: now - 47000 },
		eventsStatus: { status: "ok", at: now - 47000 },
		history: {
			hasMore: false,
			coverageComplete: false,
			events: [],
			faults: [],
			results: {
				succeeded: "0",
				failed: "0",
				timed_out: "0",
				cancelled: "0",
				rejected: "0",
			},
		},
	});
	return {
		observedAt: now,
		larm,
		items: [{ id: "larm-gpu", shape: "larm-gpu", label: "LARM GPU", state: s }],
	};
}
const gpu = (s: MonitoringSnapshot, elapsed = 0, failed = false) =>
	monitoringItems(s, failed, elapsed)!.find((i) => i.model === "larm-gpu")!;

test("three or fifty-four healthy observations produce one time, no repeated expiry notices", () => {
	for (const count of [3, 54]) {
		const item = gpu(snapshot(state(count)));
		expect(item.state.stale).toBe(false);
		expect(item.state.observedAt).toBe(now - 47000);
		expect(item.state.details).toEqual(["履歴の確認範囲は未取得です"]);
	}
});

test("missed collection, upstream stale, failed retrieval and already-old data remain visible", () => {
	expect(gpu(snapshot(), STALE_AFTER_MS - 47000 + 1).state.stale).toBe(true);
	expect(gpu(snapshot(), 0, true).state.stale).toBe(true);
	for (const status of [
		"stale",
		"permission_denied",
		"error",
		"unavailable",
		"unsupported",
	] as const) {
		const s = state();
		s.observations![0]!.status = status;
		expect(monitoringDetails(s).length).toBe(1);
		if (status === "stale") expect(gpu(snapshot(s)).state.stale).toBe(true);
	}
	const old = snapshot();
	old.items[0]!.state.observations![0]!.ageMs += 11000;
	expect(gpu(old).state.stale).toBe(true);
	const failed = snapshot();
	failed.larm!.snapshotStatus.status = "unauthorized";
	expect(gpu(failed).state.stale).toBe(true);
});

test("a coverage tail is a confirmed-through time; actual gaps and failed sources remain explicit", () => {
	const s = snapshot();
	s.larm!.history.coverage = [
		{
			id: "larm_gateway",
			status: "available",
			since: new Date(now - 60000).toISOString(),
			through: new Date(now - 10).toISOString(),
			reasonCode: null,
		},
	];
	s.larm!.history.window = {
		from: new Date(now - 60000).toISOString(),
		through: new Date(now).toISOString(),
		highWaterSequence: "0",
	};
	let notes = monitoringDetails(state(), s.larm);
	expect(notes).toHaveLength(1);
	expect(notes[0]).toContain("履歴確認:");
	expect(notes.join()).not.toContain("欠落");
	s.items[0]!.state.diagnostics!.push("history_gap");
	expect(monitoringDetails(s.items[0]!.state, s.larm).join()).toContain("欠落");
	s.larm!.history.coverage[0]!.since = new Date(now - 100).toISOString();
	expect(monitoringDetails(state(), s.larm).join()).toContain(
		"一部を確認できていません",
	);
	s.larm!.history.coverage[0]!.status = "error";
	expect(monitoringDetails(state(), s.larm).join()).toContain(
		"確認できない取得元",
	);
});

test("service details expose configured route and actual results without inventing a utilization or probe time", () => {
	const s: MonitoringSnapshot = {
		observedAt: now,
		items: [
			{
				id: "service-llm",
				shape: "llm",
				label: "LLM",
				state: {
					health: "healthy",
					activity: "idle",
					service: {
						mode: "cloud-only",
						connectionName: "設定した接続",
						model: "selected-model",
						running: 0,
						lastSuccessAt: now - 30000,
						lastFailure: null,
					},
				},
			},
		],
	};
	const item = monitoringItems(s, false, 0)!.find((i) => i.model === "llm")!;
	expect(item.state.observedAt).toBeUndefined();
	expect(item.state.checkedAt).toBe(now);
	expect(item.state.source).toBe("activity");
	expect(item.state.details).toEqual([
		"設定経路: 設定した接続",
		"設定モデル: selected-model",
		`直近の成功: ${new Date(now - 30000).toLocaleTimeString()}`,
	]);
	expect(item.state.utilization).toBeUndefined();
});
