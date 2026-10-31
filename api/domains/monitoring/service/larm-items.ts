import type { MonitoringObservation } from "../../larm/contracts";
import type { MonitoringItem } from "../contracts";
import type { LarmView } from "../contracts/larm";
import { offLan } from "./rules";
import { runtimeReadiness } from "./runtime-readiness";

type Observation = MonitoringObservation<unknown>;
type State = MonitoringItem["state"];
type Selection = { monitoringNodeId?: string; monitoringGpuId?: string };
const shapes = ["larm-core", "larm-cpu", "larm-memory", "larm-gpu"] as const;
const labels = ["LARM Core", "LARM CPU", "LARM Memory", "LARM GPU"];
const measured = <T>(o: MonitoringObservation<T>) =>
	o.status === "ok" || o.status === "stale" ? o.value : undefined;

function selected<T>(
	items: readonly T[],
	id: string | undefined,
	identity: (item: T) => string,
): T | undefined {
	const matching = id ? items.filter((item) => identity(item) === id) : items;
	return matching.length === 1 ? matching[0] : undefined;
}

/** Explicit external contract mapping. No performance baseline or GPU workload inference. */
export function larmItems(
	view: LarmView,
	selection: Selection,
	now: number,
	away = false,
): MonitoringItem[] {
	const snapshot = view.snapshot;
	// The whole read time is a conservative transit bound when host clocks differ.
	const elapsed = Math.max(
		0,
		now - (view.snapshotRequestedAt ?? view.snapshotReceivedAt ?? now),
	);
	const remoteNow = snapshot ? Date.parse(snapshot.generatedAt) + elapsed : now;
	const diagnostics = [
		view.snapshotStatus.status,
		view.eventsStatus.status,
		...(!view.history.coverageComplete ? ["history_incomplete"] : []),
		...(view.gaps.length ? ["history_gap"] : []),
	];
	const mainStatus = view.snapshotStatus.status;
	const epochMismatch =
		view.eventsStatus.status === "epoch_mismatch" ||
		(!!snapshot && view.bootEpoch !== snapshot.bootEpoch);
	if (epochMismatch) diagnostics.push("epoch_mismatch");
	const unreachable = mainStatus === "timeout" || mainStatus === "unreachable";
	function state(
		observations: Observation[],
		utilization?: number,
		activity: State["activity"] = "idle",
		health?: State["health"],
		reason?: string,
	): State {
		const metadata = observations.map((o) => ({
			status: o.status,
			observedAt: o.observedAt === null ? null : Date.parse(o.observedAt),
			ageMs:
				o.observedAt === null
					? 0
					: Math.max(0, remoteNow - Date.parse(o.observedAt)),
			maxAgeMs: o.maxAgeMs,
		}));
		const unavailable =
			metadata.length === 0 || metadata.some((o) => o.observedAt === null);
		const stale =
			observations.some(
				(o) => o.observedAt !== null && Date.parse(o.observedAt) > remoteNow,
			) ||
			metadata.some((o) => o.status === "stale" || o.ageMs > o.maxAgeMs) ||
			mainStatus !== "ok" ||
			epochMismatch;
		return {
			health: unreachable
				? "disconnected"
				: mainStatus !== "ok" || epochMismatch
					? "unknown"
					: (health ?? (unavailable ? "unknown" : "healthy")),
			activity,
			stale,
			observations: metadata,
			diagnostics,
			...(utilization !== undefined ? { utilization } : {}),
			...(reason
				? { reason }
				: mainStatus !== "ok"
					? { reason: mainStatus }
					: unavailable
						? { reason: "measurement_unavailable" }
						: {}),
		};
	}
	let states: State[];
	if (!snapshot) states = shapes.map(() => state([]));
	else {
		const core = snapshot.core;
		const failed =
			measured(core.readiness) === "failed" ||
			core.runtimes.some(
				(r) =>
					measured(r.status) === "FAILED" ||
					measured(r.modelLoadState) === "failed",
			);
		const starting =
			["starting", "verifying"].includes(measured(core.readiness) ?? "") ||
			core.runtimes.some(
				(r) =>
					measured(r.status) === "STARTING" ||
					measured(r.modelLoadState) === "loading",
			);
		const working = (measured(core.activeWorkloads) ?? 0) > 0;
		const node = selected(
			snapshot.nodes,
			selection.monitoringNodeId,
			(n) => n.nodeId,
		);
		const gpus = node?.gpus.value?.filter((gpu) => gpu.nodeId === node.nodeId);
		const gpu = selected(gpus ?? [], selection.monitoringGpuId, (g) => g.id);
		const total = node && measured(node.memory.memTotal),
			available = node && measured(node.memory.memAvailable);
		const memoryValid =
			total !== undefined &&
			total > 0 &&
			available !== undefined &&
			available <= total;
		states = [
			state(
				[
					core.readiness,
					core.activeWorkloads,
					...core.runtimes.flatMap((r) => [
						r.status,
						...(r.modelLoadState.observedAt ? [r.modelLoadState] : []),
					]),
				],
				undefined,
				starting ? "starting" : working ? "working" : "idle",
				failed ? "fault" : undefined,
				failed ? "larm_reported_failure" : undefined,
			),
			node
				? state(
						[node.cpu.utilization],
						measured(node.cpu.utilization) === undefined
							? undefined
							: measured(node.cpu.utilization)! / 100,
					)
				: state([], undefined, "idle", "unknown", "selection_required"),
			node
				? state(
						[node.memory.memTotal, node.memory.memAvailable],
						memoryValid ? 1 - available! / total! : undefined,
						"idle",
						memoryValid ? undefined : "unknown",
					)
				: state([], undefined, "idle", "unknown", "selection_required"),
			gpu && node
				? state(
						[node.gpus, gpu.identity, gpu.utilization],
						measured(gpu.utilization) === undefined
							? undefined
							: measured(gpu.utilization)! / 100,
					)
				: state(
						node ? [node.gpus] : [],
						undefined,
						"idle",
						"unknown",
						gpus?.length ? "selection_required" : "gpu_unavailable",
					),
		];
		const readiness = measured(core.readiness);
		states[0]!.readiness =
			readiness === "ready"
				? "ready"
				: readiness === "starting" || readiness === "verifying"
					? "starting"
					: readiness === "draining"
						? "stopping"
						: readiness === "failed"
							? "failed"
							: "unknown";
		states[0]!.runtimeStates = runtimeReadiness(snapshot);
		for (const [index, kind] of [
			[2, "node"],
			[3, "gpu"],
		] as const) {
			const id = kind === "node" ? node?.nodeId : gpu?.id;
			const faults = view.history.faults.filter(
				(e) =>
					id &&
					e.target.type === kind &&
					e.target.id === id &&
					(!e.target.nodeId || e.target.nodeId === node?.nodeId) &&
					e.streamId === view.history.eventStream?.streamId &&
					view.bootEpoch === snapshot.bootEpoch &&
					(kind === "node"
						? e.kind === "host.oom_kill_observed"
						: e.kind.startsWith("gpu.")) &&
					Date.parse(e.occurredAt) <= remoteNow &&
					remoteNow - Date.parse(e.occurredAt) < 600_000,
			);
			const fault = faults.sort(
				(a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt),
			)[0];
			const target = states[index]!;
			if (fault && mainStatus === "ok" && !epochMismatch) {
				target.settledHealth = target.health;
				target.health = "fault";
				target.reason = fault.kind;
				target.faultRemainingMs = Math.max(
					0,
					600_000 - (remoteNow - Date.parse(fault.occurredAt)),
				);
			}
		}
	}
	return shapes.map((shape, i) => ({
		id: shape,
		shape,
		label: labels[i]!,
		state: away ? offLan(states[i]!) : states[i]!,
	}));
}
