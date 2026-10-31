import { getLogger } from "../../../infrastructure/logger";
import type {
	ActivityObservation,
	ActivityRecorder,
	LarmStatus,
} from "../../larm";
import type { QueueStatus } from "../../queue";
import type { Settings } from "../../settings/contracts";
import type {
	MonitoringItem,
	MonitoringShape,
	MonitoringSnapshot,
} from "../contracts";
import { createHostMetrics } from "./host";
import { createLanPresence } from "./lan";
import { hostLimits, hostState, serviceState } from "./rules";
import type { LarmCollector } from "./larm-collector";
import { larmItems } from "./larm-items";
import { routeState } from "./route-state";

const log = getLogger("monitoring");
/** Outcomes older than this say nothing about the service now (§3). */
const WINDOW_MS = 10 * 60_000;
const none: ActivityObservation = {
	running: 0,
	lastSuccessAt: null,
	lastFailure: null,
};

type Group = "llm" | "asr" | "tts";
type Activity = (since: number) => ActivityObservation;
export type MonitoringDeps = {
	settings: {
		get(): Settings;
		diagnostics(): {
			connections: { id: string; credentialAvailable: boolean }[];
		};
	};
	larmStatus(): LarmStatus;
	attempts(since: number): Record<Group, ActivityObservation>;
	image?: Activity;
	music?: Activity;
	embedding: ActivityRecorder;
	judge: ActivityRecorder;
	queue: { stats(): QueueStatus };
	/** The data directory; its volume is the SSD that is measured. */
	dataDir: string;
	host?: ReturnType<typeof createHostMetrics>;
	now?: () => number;
	remote?: LarmCollector;
	/** Whether LARM is expected to answer from here; see ./lan.ts. */
	onLan?: () => Promise<boolean>;
};

const labels: Record<MonitoringShape, string> = {
	cpu: "CPU",
	memory: "Memory",
	ssd: "SSD",
	network: "Eumenes Backend",
	llm: "LLM",
	asr: "ASR",
	tts: "TTS",
	embedding: "Embedding",
	attitude: "態度判定",
	image: "画像生成",
	music: "楽曲生成",
	"larm-core": "LARM Core",
	"larm-cpu": "LARM CPU",
	"larm-memory": "LARM Memory",
	"larm-gpu": "LARM GPU",
};
const ids: Record<MonitoringShape, string> = {
	cpu: "eumenes-host-cpu",
	memory: "eumenes-host-memory",
	ssd: "eumenes-host-ssd",
	network: "eumenes-backend",
	llm: "service-llm",
	asr: "service-asr",
	tts: "service-tts",
	embedding: "service-embedding",
	attitude: "service-attitude",
	image: "service-image",
	music: "service-music",
	"larm-core": "larm-core",
	"larm-cpu": "larm-cpu",
	"larm-memory": "larm-memory",
	"larm-gpu": "larm-gpu",
};

/** Reads only: owner domains supply outcomes, this domain judges health (spec §3). */
export function createMonitoring(deps: MonitoringDeps) {
	const now = deps.now ?? Date.now;
	const host = deps.host ?? createHostMetrics(deps.dataDir);
	const previous = new Map<string, string>();
	const onLan =
		deps.onLan ??
		createLanPresence(() => deps.settings.get().larm?.baseUrl ?? null);

	function larmReachable(status: LarmStatus) {
		return status.state !== "unconfigured" && status.state !== "failed";
	}

	function item(
		shape: MonitoringShape,
		state: MonitoringItem["state"],
	): MonitoringItem {
		const id = ids[shape];
		const before = previous.get(id);
		if (before !== state.health) {
			previous.set(id, state.health);
			if (before !== undefined)
				log.info("monitoring.health_changed", {
					subjectId: id,
					status: state.health,
					...(state.reason ? { reason: state.reason } : {}),
				});
		}
		return { id, shape, label: labels[shape], state };
	}

	return {
		close: async () => {
			await deps.remote?.close();
		},
		async snapshot(): Promise<MonitoringSnapshot> {
			const [remote, lan] = await Promise.all([deps.remote?.read(), onLan()]);
			const observedAt = now();
			const since = observedAt - WINDOW_MS;
			const settings = deps.settings.get();
			const status = deps.larmStatus();
			const larm = larmReachable(status);
			const starting = status.state === "connecting";
			const attempts = deps.attempts(since);
			const queue = deps.queue.stats();
			const sample = await host.sample();
			const busy =
				Object.values(queue.lanes).some((lane) => lane.running > 0) ||
				Object.values(attempts).some((a) => a.running > 0);
			const credentials = deps.settings.diagnostics().connections;
			const route = (purpose: Group) =>
				routeState(
					settings,
					purpose,
					attempts[purpose],
					status,
					lan,
					credentials,
				);
			const recorded = (o: ActivityObservation): MonitoringItem["state"] => ({
				...serviceState(
					{ ...o, ...recentOnly(o, since) },
					larm,
					starting,
					!lan,
				),
				...(larm ? { readiness: starting ? "starting" : "configured" } : {}),
			});
			return {
				observedAt,
				...(remote ? { larm: remote } : {}),
				items: [
					item(
						"cpu",
						hostState(sample.cpu, (u) => u > hostLimits.cpuPressure),
					),
					item(
						"memory",
						hostState(sample.memory, (u) => u > hostLimits.memoryPressure),
					),
					item(
						"ssd",
						hostState(
							sample.disk,
							(u) => 1 - u < hostLimits.diskFreePressure,
							(u) => 1 - u < hostLimits.diskFreeFault,
						),
					),
					// Answering at all is the backend's health; its load is shown, never coloured (Q7).
					item("network", {
						health: "healthy",
						activity: busy ? "working" : "idle",
						...(sample.process === undefined
							? {}
							: { utilization: sample.process }),
					}),
					item("llm", route("llm")),
					item("asr", route("asr")),
					item("tts", route("tts")),
					item("embedding", recorded(deps.embedding.observe())),
					item("attitude", recorded(deps.judge.observe())),
					item("image", recorded(deps.image?.(since) ?? none)),
					item("music", recorded(deps.music?.(since) ?? none)),
					...(remote ? larmItems(remote, settings.larm, now(), !lan) : []),
				],
			};
		},
	};
}

/** In-memory recorders keep outcomes forever; only the window counts. */
function recentOnly(o: ActivityObservation, since: number) {
	return {
		lastSuccessAt:
			o.lastSuccessAt !== null && o.lastSuccessAt >= since
				? o.lastSuccessAt
				: null,
		lastFailure:
			o.lastFailure && o.lastFailure.at >= since ? o.lastFailure : null,
	};
}

export type MonitoringService = ReturnType<typeof createMonitoring>;
