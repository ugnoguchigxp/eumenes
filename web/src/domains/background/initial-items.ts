import type { SpatialItem } from "./contracts";

/** Layout placeholders only. No simulated pressure or invented provider health. */
export const initialSpatialItems: readonly SpatialItem[] = [
	{ id: "mac-cpu", label: "CPU", model: "cpu", position: [-1.4, 1, 0] },
	{ id: "mac-memory", label: "Memory", model: "memory", position: [1.4, 1, 0] },
	{ id: "mac-ssd", label: "SSD", model: "ssd", position: [-1.4, -1, 0] },
	{
		id: "mac-network",
		label: "Network",
		model: "network",
		position: [1.4, -1, 0],
	},
].map((item) => ({
	...item,
	position: item.position as [number, number, number],
	state: { health: "unknown", activity: "idle", stale: false },
}));
