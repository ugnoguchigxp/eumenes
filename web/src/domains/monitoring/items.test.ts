import { expect, test } from "vitest";
import type { MonitoringSnapshot } from "../../../../api/domains/monitoring/contracts";
import { monitoringItems, STALE_AFTER_MS } from "./items";

const snapshot: MonitoringSnapshot = {
	observedAt: 1000,
	items: [
		{
			id: "eumenes-backend",
			shape: "network",
			label: "Eumenes Backend",
			state: { health: "healthy", activity: "working", utilization: 0.2 },
		},
		{
			id: "service-llm",
			shape: "llm",
			label: "LLM",
			state: { health: "fault", activity: "idle", reason: "x_bad" },
		},
	],
};

test("before the first read the background keeps its unconfirmed samples", () => {
	expect(monitoringItems(undefined, false, 0)).toBeUndefined();
});

test("snapshot states replace the samples on the same layout, by shape", () => {
	const items = monitoringItems(snapshot, false, 0)!;
	expect(items).toHaveLength(14);
	const backend = items.find((i) => i.model === "backend")!;
	expect(backend.id).toBe("eumenes-backend");
	expect(backend.label).toBe("Eumenes Backend");
	expect(backend.state).toEqual({
		health: "healthy",
		activity: "working",
		stale: false,
		utilization: 0.2,
		source: "measurement",
		observedAt: 1000,
	});
	const llm = items.find((i) => i.model === "llm")!;
	expect(llm.state.health).toBe("fault");
	expect(llm.state.utilization).toBeUndefined();
	// A shape the snapshot does not report stays unconfirmed.
	expect(items.find((i) => i.model === "cpu")!.state.source).toBe(
		"unconfirmed",
	);
});

test("an unanswered read disconnects the backend and makes the rest old", () => {
	const items = monitoringItems(snapshot, true, 0)!;
	expect(items.find((i) => i.model === "backend")!.state.health).toBe(
		"disconnected",
	);
	expect(items.every((i) => i.state.stale)).toBe(true);
	expect(
		monitoringItems(undefined, true, 0)!.find((i) => i.model === "backend")!
			.state.health,
	).toBe("disconnected");
	expect(
		monitoringItems(snapshot, false, STALE_AFTER_MS + 1)!.find(
			(i) => i.model === "llm",
		)!.state.stale,
	).toBe(true);
});

test("the five unobserved new shapes never borrow telemetry from removed service samples", () => {
	const items = monitoringItems(snapshot, false, 0)!;
	for (const id of [
		"external",
		"larm-core",
		"larm-cpu",
		"larm-memory",
		"larm-gpu",
	]) {
		const state = items.find((item) => item.model === id)!.state;
		expect(state.health).toBe("unknown");
		expect(state.source).toBe("unconfirmed");
		expect(state.utilization).toBeUndefined();
	}
});
