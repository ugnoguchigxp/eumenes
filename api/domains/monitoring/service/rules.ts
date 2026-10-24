import { fallbackErrors } from "../../inference";
import type { ActivityObservation } from "../../larm";
import type { MonitoringItem } from "../contracts";

type State = MonitoringItem["state"];
/** Failures that mean the service could not be reached; they are a disconnection, not a fault. A timeout reached it. */
const unreachable =
	/^(larm_profile_missing|larm_connection_released|larm_closed|larm_failed|larm_provider_not_ready|larm_system_one_unavailable|image_service_unavailable|music_service_unavailable)$/;
export const connectionFailure = (reason: string) =>
	(fallbackErrors.test(reason) && reason !== "local_timeout") ||
	unreachable.test(reason);

/** Off the LAN, LARM not answering is expected: unknown, not a disconnection (spec §12). */
export const offLan = (state: State): State =>
	state.health === "disconnected"
		? { ...state, health: "unknown", reason: "larm_off_lan" }
		: state;

/**
 * A service's state from its newest outcome. `reachable` false (no saved connection, LARM failed,
 * a cloud route without credential) is a disconnection whatever the outcomes say.
 * `away` marks a route through LARM while this host is off the LAN.
 */
export function serviceState(
	o: ActivityObservation,
	reachable: boolean,
	starting = false,
	away = false,
): State {
	const state = judged(o, reachable, starting);
	return away ? offLan(state) : state;
}

function judged(
	o: ActivityObservation,
	reachable: boolean,
	starting: boolean,
): State {
	const activity = o.running > 0 ? "working" : starting ? "starting" : "idle";
	if (!reachable) return { health: "disconnected", activity };
	const failure = o.lastFailure;
	if (failure && (o.lastSuccessAt === null || failure.at > o.lastSuccessAt))
		return {
			health: connectionFailure(failure.reason) ? "disconnected" : "fault",
			activity,
			reason: failure.reason,
		};
	return { health: o.lastSuccessAt === null ? "unknown" : "healthy", activity };
}

/** Thresholds agreed in spec/spatial-monitoring-eumenes-design-2026-10-18.md §3 (Q3). */
export const hostLimits = {
	cpuPressure: 0.85,
	memoryPressure: 0.9,
	diskFreePressure: 0.1,
	diskFreeFault: 0.03,
};

export function hostState(
	used: number | undefined,
	pressure: (used: number) => boolean,
	fault: (used: number) => boolean = () => false,
): State {
	if (used === undefined) return { health: "unknown", activity: "idle" };
	const utilization = Math.min(1, Math.max(0, used));
	return {
		health: fault(utilization)
			? "fault"
			: pressure(utilization)
				? "pressure"
				: "healthy",
		activity: "idle",
		utilization,
	};
}
