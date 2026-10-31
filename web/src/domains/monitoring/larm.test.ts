import { expect, test } from "vitest";
import type {
	MonitoringSnapshot,
	MonitoringItem,
} from "../../../../api/domains/monitoring/contracts";
import { monitoringItems } from "./items";
const observation = {
	status: "ok" as const,
	observedAt: Date.parse("2026-10-18T08:30:00.000Z"),
	ageMs: 2000,
	maxAgeMs: 10000,
};
const snapshot = (
	state: Partial<MonitoringItem["state"]> = {},
): MonitoringSnapshot => ({
	observedAt: 1234,
	items: [
		{
			id: "larm-cpu",
			shape: "larm-cpu",
			label: "LARM CPU",
			state: {
				health: "healthy",
				activity: "idle",
				utilization: 0,
				stale: false,
				observations: [observation],
				...state,
			},
		},
	],
});
const cpu = (s: MonitoringSnapshot, age: number) =>
	monitoringItems(s, false, age)!.find((i) => i.model === "larm-cpu")!.state;
test("LARM age starts at the original observation, not the successful product response", () => {
	expect(cpu(snapshot(), 0).stale).toBe(false);
	// A valid sample remains the last checked value between the agreed minute polls.
	expect(cpu(snapshot(), 47000).stale).toBe(false);
	expect(cpu(snapshot(), 180001).stale).toBe(true);
	expect(cpu(snapshot(), 0).observedAt).toBe(observation.observedAt);
	expect(cpu(snapshot(), 0).utilization).toBe(0);
	expect(
		cpu(snapshot({ observations: [{ ...observation, ageMs: 60000 }] }), 0)
			.stale,
	).toBe(true);
});
test("unavailable data is unconfirmed without a fabricated observation time, and expired faults settle without a new response", () => {
	const unknown = cpu(
		snapshot({
			health: "unknown",
			utilization: undefined,
			observations: [
				{ ...observation, status: "permission_denied", observedAt: null },
			],
		}),
		0,
	);
	expect(unknown.utilization).toBeUndefined();
	expect(unknown.observedAt).toBeUndefined();
	expect(unknown.source).toBe("unconfirmed");
	const fault = snapshot({
		health: "fault",
		settledHealth: "healthy",
		faultRemainingMs: 5000,
		reason: "gpu.reset_observed",
	});
	expect(cpu(fault, 4999).health).toBe("fault");
	expect(cpu(fault, 5000).health).toBe("healthy");
});
