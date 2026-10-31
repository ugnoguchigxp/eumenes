import { expect, test } from "vitest";
import { statusColor, statusLabel, readinessLabels } from "./status";
import { healthColors, standbyColor } from "./options";
import type { SpatialState } from "./contracts";

const s: SpatialState = { health: "unknown", activity: "idle", stale: false };
test("known readiness replaces an unhelpful unknown headline, while keeping the actual health separate", () => {
	for (const readiness of [
		"configured",
		"ready",
		"warm_ready",
		"cold",
	] as const) {
		expect(statusLabel({ ...s, readiness })).toBe("待機中");
		expect(statusColor({ ...s, readiness })).toBe(standbyColor);
	}
	expect(readinessLabels.warm_ready).toBe("Warm ready");
	expect(statusLabel(s)).toBe("状態情報なし");
	expect(statusColor(s)).toBe(healthColors.unknown);
});
test("warning, fault and disconnected hues override ready and activity, and host idleness is still healthy cyan", () => {
	const ready = {
		...s,
		readiness: "warm_ready" as const,
		activity: "working" as const,
	};
	for (const health of ["pressure", "fault", "disconnected"] as const)
		expect(statusColor({ ...ready, health })).toBe(healthColors[health]);
	expect(statusColor({ ...s, health: "healthy" })).toBe(healthColors.healthy);
	expect(statusColor({ ...ready, activity: "starting" })).toBe(
		healthColors.pressure,
	);
	expect(statusColor({ ...ready, stale: true })).toBe(healthColors.pressure);
});
