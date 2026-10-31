import type { ActivityObservation, LarmStatus } from "../../larm";
import type { Purpose, Settings } from "../../settings/contracts";
import type { MonitoringItem } from "../contracts";
import { serviceState } from "./rules";

export function routeState(
	settings: Settings,
	purpose: Purpose,
	observation: ActivityObservation,
	status: LarmStatus,
	onLan: boolean,
	credentials: { id: string; credentialAvailable: boolean }[],
): MonitoringItem["state"] {
	const route = settings.routes[purpose];
	const resource = settings.resources.find((r) => r.id === route.fallbackId);
	const connection = settings.connections.find(
		(c) => c.id === resource?.connectionId,
	);
	// Settings' authentication contract permits Codex login without a stored API key.
	const cloud =
		!!connection?.enabled &&
		(connection.kind === "codex-sdk" ||
			credentials.some((c) => c.id === connection.id && c.credentialAvailable));
	const viaLarm =
		route.mode !== "cloud-only" &&
		!(route.mode === "larm-preferred" && route.cloudAllowed && cloud);
	const reachable = viaLarm
		? status.state !== "unconfigured" && status.state !== "failed"
		: cloud;
	const state = serviceState(
		observation,
		reachable,
		status.state === "connecting" && route.mode !== "cloud-only",
		viaLarm && !onLan,
	);
	return {
		...state,
		readiness:
			!reachable || state.health === "disconnected"
				? "unknown"
				: state.activity === "starting"
					? "starting"
					: (route.mode !== "cloud-only" &&
								status.state === "ready" &&
								status.capabilities.includes(purpose)) ||
						  (route.mode === "cloud-only" &&
								observation.lastSuccessAt !== null)
						? "ready"
						: "configured",
		...(!state.reason && !reachable
			? { reason: viaLarm ? "larm_failed" : "service_connection_unavailable" }
			: {}),
		service: {
			mode: route.mode,
			cloudAllowed: route.cloudAllowed,
			...(route.mode === "cloud-only" && connection
				? {
						connectionName: connection.name,
						model: resource?.model,
					}
				: {}),
			...observation,
		},
	};
}
