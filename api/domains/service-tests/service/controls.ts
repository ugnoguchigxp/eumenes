import type { Database } from "bun:sqlite";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import type { ServiceTarget, ServiceRun } from "../contracts";
import { readRun, readRuns, updateRun } from "../repository";
/** Audio tests share the device with a live voice frontend; other kinds keep their lifecycle. */
export function createTestControls(
	store: SqliteStore,
	active: ReadonlyMap<string, AbortController>,
	previews: { delete: (id: string) => unknown },
) {
	let available: (db: Database) => boolean = () => true;
	const voice = (kind: ServiceRun["kind"]) => kind === "asr" || kind === "tts";
	/**
	 * Mark the run as stopping; the returned function aborts it once the write commits. It
	 * decides by the run's status, not its phase: a progress save between the commit and this
	 * call may rewrite the phase, but a run that is still running must still be aborted.
	 */
	function cancelInTransaction(db: Database, id: string) {
		const r = readRun(db, id);
		if (!r) throw new Error("invalid_test_run");
		if (r.status !== "running") return () => true;
		updateRun(db, id, { phase: "cancelling" });
		return () => {
			if (store.read((d) => readRun(d, id))?.status === "running") {
				active.get(id)?.abort();
				previews.delete(id);
			}
			return true;
		};
	}

	return {
		cancelInTransaction,
		setVoiceAvailability(check: (db: Database) => boolean) {
			available = check;
		},
		assertAllowed(db: Database, kind: ServiceRun["kind"]) {
			if (voice(kind) && !available(db))
				throw new Error("live_legacy_voice_disabled");
		},
		target(target: ServiceTarget): ServiceTarget {
			return voice(target.kind) && !store.read(available)
				? { ...target, testable: false, reason: "live_legacy_voice_disabled" }
				: target;
		},
		async pauseVoice() {
			const stops = await store.write((db) =>
				readRuns(db)
					.filter((r) => r.status === "running" && voice(r.kind))
					.map((r) => cancelInTransaction(db, r.id)),
			);
			for (const stop of stops) stop();
		},
	};
}
