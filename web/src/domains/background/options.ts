import type { SpatialState } from "./contracts";

export type SpatialOptions = {
	scatter: number;
	core: number;
	focusCore: number;
	pointSize: number;
	opacity: number;
	orbitSpeed: number;
	spinSpeed: number;
	paused: boolean;
	reducedMotion: boolean;
	view: "oblique" | "top";
	demoEnabled: boolean;
	demoHealth: SpatialState["health"];
	demoActivity: SpatialState["activity"];
	demoUtilization: number;
	demoStrength: number;
	demoStale: boolean;
};
export const defaultSpatialOptions: SpatialOptions = {
	scatter: 350,
	core: 40,
	focusCore: 60,
	pointSize: 100,
	opacity: 80,
	orbitSpeed: 50,
	spinSpeed: 0,
	paused: false,
	reducedMotion: false,
	view: "oblique",
	demoEnabled: false,
	demoHealth: "healthy",
	demoActivity: "working",
	demoUtilization: 50,
	demoStrength: 65,
	demoStale: false,
};
const bounded = (v: number, lo: number, hi: number, fallback: number) =>
	Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : fallback;
export function normalizeOptions(
	input: Partial<SpatialOptions> = {},
): SpatialOptions {
	const out = { ...defaultSpatialOptions, ...input };
	for (const [key, lo, hi] of [
		["scatter", 0, 500],
		["core", 10, 90],
		["focusCore", 10, 90],
		["pointSize", 50, 200],
		["opacity", 20, 100],
		["orbitSpeed", 0, 200],
		["spinSpeed", 0, 100],
		["demoUtilization", 0, 100],
		["demoStrength", 0, 100],
	] as const)
		out[key] = bounded(out[key], lo, hi, defaultSpatialOptions[key]);
	return out;
}

/** Independent from health: high utilization is not an error classification. */
export function activityStrength(state: SpatialState) {
	if (
		state.stale ||
		state.health === "unknown" ||
		state.health === "disconnected" ||
		state.activity === "idle"
	)
		return 0;
	return bounded(state.strength ?? 0.65, 0, 1, 0);
}
/** Status colours requested by the user; utilization must never change their meaning. */
export const healthColors: Record<SpatialState["health"], string> = {
	healthy: "#00b8f5",
	pressure: "#ffe600",
	fault: "#ff243f",
	disconnected: "#b65cff",
	unknown: "#8795a5",
};
export const standbyColor = "#ffffff";
