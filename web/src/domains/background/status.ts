import type { SpatialState } from "./contracts";
import { healthColors, standbyColor } from "./options";

const colors = { ...healthColors, idle: standbyColor };
const labels = {
	healthy: "Healthy",
	idle: "待機中",
	pressure: "注意",
	fault: "状態悪化",
	disconnected: "無接続",
	unknown: "状態情報なし",
};

/** Presentation only: do not turn a prepared connection into a successful health check. */
function tone(s: SpatialState): keyof typeof colors {
	if (s.health === "disconnected") return "disconnected";
	if (s.health === "fault" || s.readiness === "failed") return "fault";
	if (
		s.health === "pressure" ||
		s.stale ||
		s.activity === "starting" ||
		s.readiness === "starting" ||
		s.readiness === "stopping"
	)
		return "pressure";
	if (s.activity === "idle" && s.readiness && s.readiness !== "unknown")
		return "idle";
	return s.health === "healthy" ||
		(s.activity === "working" && s.readiness && s.readiness !== "unknown")
		? "healthy"
		: "unknown";
}
export const statusColor = (state: SpatialState) => colors[tone(state)];
export const statusLabel = (state: SpatialState) => labels[tone(state)];
export const readinessLabels: Record<
	NonNullable<SpatialState["readiness"]>,
	string
> = {
	configured: "要求時に準備",
	ready: "Ready",
	warm_ready: "Warm ready",
	cold: "Cold（モデル未読込）",
	starting: "準備中",
	stopping: "停止処理中",
	failed: "準備失敗",
	unknown: "準備情報なし",
};
export const statusLegend = [
	["正常", healthColors.healthy],
	["待機", standbyColor],
	["注意", healthColors.pressure],
	["状態悪化", healthColors.fault],
	["無接続", healthColors.disconnected],
] as const;
