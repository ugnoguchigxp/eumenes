import type { Database } from "bun:sqlite";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import type { Purpose, Settings, SettingsService } from "../../settings";
import type { LarmPort } from "../../larm";
import type { Messages, Receipt } from "../contracts";
import { safeError } from "./errors";
import { finishProbe, openProbe } from "./probe";
import { probeWav } from "./wav";

/** Connection probes and one-off resource tests, run in the background and recorded in `inference_probes`. */
export function createProbes({
	store,
	settings,
	port,
	capture,
	executeRequest,
	accept,
}: {
	store: SqliteStore;
	settings: SettingsService;
	port: (s: Settings) => LarmPort;
	capture: (
		db: Database,
		subject: string,
		purpose: Purpose,
		deadline: number,
		snapshot?: Settings,
	) => string;
	executeRequest: (
		id: string,
		input: Messages | string | Uint8Array,
		signal: AbortSignal,
	) => Promise<Receipt>;
	accept: (db: Database, receipt: Receipt) => boolean;
}) {
	const api = {
		getProbe: (id: string) =>
			store.read((db) =>
				db.query("SELECT * FROM inference_probes WHERE id=?").get(id),
			),
		probes: () =>
			store.read((db) =>
				db
					.query(
						"SELECT * FROM inference_probes ORDER BY created DESC LIMIT 20",
					)
					.all(),
			),
		async testResource(
			resourceId: string,
			input: Messages | string | Uint8Array,
			signal: AbortSignal,
		) {
			const snapshot = settings.get();
			const resource = snapshot.resources.find((r) => r.id === resourceId);
			if (!resource) throw new Error("invalid_probe_target");
			const fixed = structuredClone(snapshot);
			fixed.routes[resource.purpose].mode = "cloud-only";
			fixed.routes[resource.purpose].fallbackId = resourceId;
			const id = await store.write((db) =>
				capture(
					db,
					`probe:${crypto.randomUUID()}`,
					resource.purpose,
					Date.now() + 120_000,
					fixed,
				),
			);
			const receipt = await executeRequest(id, input, signal);
			signal.throwIfAborted();
			if (!(await store.write((db) => accept(db, receipt))))
				throw new Error("permission_revoked");
			return receipt.value;
		},
		/**
		 * Register a probe inside the caller's writer transaction. The caller runs `launch` after
		 * the commit; it does nothing when the registration was rolled back.
		 */
		startProbeInTransaction(db: Database, target: string) {
			const current = settings.inTransaction(db);
			if (target !== "larm" && !current.resources.some((r) => r.id === target))
				throw new Error("invalid_probe_target");
			const id = crypto.randomUUID();
			openProbe(db, id, target, current.revision);
			return {
				id,
				launch() {
					if (api.getProbe(id)) launchProbe(id, target, current);
				},
			};
		},
		cancelProbe(id: string) {
			probeControllers.get(id)?.abort();
		},
		/**
		 * Mark a running probe as being cancelled inside the caller's writer transaction. The
		 * caller aborts it (`cancelProbe`) after the commit, only if the mark is still there.
		 */
		cancelProbeInTransaction(db: Database, id: string) {
			const changed = db
				.query(
					"UPDATE inference_probes SET status='cancelling' WHERE id=? AND status='running'",
				)
				.run(id).changes;
			if (changed) return;
			if (!db.query("SELECT 1 FROM inference_probes WHERE id=?").get(id))
				throw new Error("probe_not_found");
			throw new Error("probe_not_running");
		},
	};
	const probeControllers = new Map<string, AbortController>();
	const probeTasks = new Set<Promise<void>>();
	/** Runs the probe of a registered `inference_probes` row in the background. */
	function launchProbe(id: string, target: string, current: Settings) {
		const controller = new AbortController();
		probeControllers.set(id, controller);
		const task = (async () => {
			try {
				if (target === "larm") {
					await port(current).probe?.(
						AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
					);
				} else {
					const resource = current.resources.find((r) => r.id === target);
					if (!resource) throw new Error("invalid_probe_target");

					const snap = structuredClone(current);
					snap.routes[resource.purpose].mode = "cloud-only";
					snap.routes[resource.purpose].fallbackId = resource.id;
					const requestId = await store.write((db) =>
						capture(
							db,
							`probe:${id}`,
							resource.purpose,
							Date.now() + 15_000,
							snap,
						),
					);
					const receipt = await executeRequest(
						requestId,
						resource.purpose === "llm"
							? [{ role: "user", content: "Reply OK." }]
							: resource.purpose === "tts"
								? "接続のテストです。"
								: probeWav(),
						controller.signal,
					);
					if (!(await store.write((db) => accept(db, receipt))))
						throw new Error("permission_revoked");
				}
				controller.signal.throwIfAborted();
				await finishProbe(
					store,
					id,
					settings.get().revision === current.revision ? "succeeded" : "stale",
				);
			} catch (error) {
				await finishProbe(
					store,
					id,
					controller.signal.aborted ? "cancelled" : "failed",
					safeError(error, controller.signal),
				);
			} finally {
				probeControllers.delete(id);
			}
		})();
		probeTasks.add(task);
		void task.finally(() => probeTasks.delete(task)).catch(() => {});
	}
	return {
		...api,
		/** Aborts every running probe. */
		abortAll() {
			for (const c of probeControllers.values()) c.abort();
		},
		/** Settles when no probe task is left running. */
		settled: () => Promise.allSettled(probeTasks),
	};
}
