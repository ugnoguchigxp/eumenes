import type { SqliteStore } from "../../../infrastructure/sqlite";
import {
	silentWav,
	type LarmPlayground,
	type LarmTestTarget,
	type TestOutput,
	type TestProgress,
} from "../../larm";
import type { InferenceService } from "../../inference";
import type { SettingsService } from "../../settings";
import type {
	HealthRow,
	ServiceCatalog,
	ServiceTarget,
	StartTest,
} from "../contracts";
import { readRun, type RunRecord } from "../repository";

/** The work of one run: runs after its row committed, under the run's abort signal. */
export type Work = (signal: AbortSignal) => Promise<TestOutput | void>;
type Settings = ReturnType<SettingsService["get"]>;

/** What the work of a run needs from the service that launches it. */
export type WorkDeps = {
	store: SqliteStore;
	save: (id: string, change: Partial<RunRecord>) => Promise<unknown>;
	inference: Pick<InferenceService, "testResource">;
	gateway: (s?: Settings) => LarmPlayground;
	uploads: ReadonlyMap<string, { bytes: Uint8Array }>;
	refresh: () => Promise<ServiceCatalog>;
	catalog: () => ServiceCatalog;
	/** The LARM targets of the latest discovery. */
	targets: () => ReadonlyMap<string, LarmTestTarget> | undefined;
};

/** One test of a cloud model or a LARM service. */
export function startWork(
	deps: WorkDeps,
	record: RunRecord,
	input: StartTest["input"],
	target: ServiceTarget,
	s: Settings,
): Work {
	const upload = input.uploadId ? deps.uploads.get(input.uploadId) : undefined;
	const internal = deps.targets()?.get(target.id);
	return async (signal) => {
		const progress = async (p: TestProgress) => {
			const current = deps.store.read((db) => readRun(db, record.id));
			if (current?.status !== "running") return;
			await deps.save(record.id, p);
		};
		if (target.source === "cloud") {
			const value = await deps.inference.testResource(
				target.id.slice(6),
				target.kind === "llm"
					? [{ role: "user", content: input.text }]
					: target.kind === "asr"
						? (upload?.bytes ?? silentWav())
						: input.text,
				signal,
			);
			return typeof value === "string"
				? { text: value }
				: { bytes: value, mime: "audio/wav" };
		}
		const g = deps.gateway(s);
		const fresh = await g.catalog(signal);
		const next = fresh.targets.find((t) => t.id === target.id);
		if (!internal || !next || next.revision !== internal.revision)
			throw new Error("stale_catalog");
		return g.execute(
			next,
			{ ...input, audio: upload?.bytes },
			signal,
			progress,
		);
	};
}

/** The Health diagnosis: refresh the catalog, then ask each primary service for its Health. */
export function diagnoseWork(
	deps: WorkDeps,
	record: RunRecord,
	s: Settings,
): Work {
	return async (signal) => {
		await deps.refresh();
		const selected = deps.catalog().targets.filter((t) => t.primary);
		const targets = new Map(deps.targets());
		const g = deps.gateway(s);
		const controlHealthy = await g.controlHealth(signal).catch(() => false);
		await deps.save(record.id, { controlHealthy });
		const health: HealthRow[] = [];
		for (const t of selected) {
			signal.throwIfAborted();
			const internal = targets.get(t.id);
			const result =
				t.source === "cloud"
					? {
							state: "unsupported" as const,
							reason: t.testable
								? "cloud_health_unsupported"
								: "invalid_permission",
							checkedAt: Date.now(),
						}
					: internal
						? await g.health(
								internal,
								AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
							)
						: {
								state: "unknown" as const,
								reason: "unsupported_protocol",
								checkedAt: Date.now(),
							};
			health.push({
				...result,
				targetId: t.id,
				name: t.name,
				model: t.model,
			});
			await deps.save(record.id, { health: [...health] });
		}
	};
}
