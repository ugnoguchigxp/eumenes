import type { Database } from "bun:sqlite";
import type {
	MemorySettingsInput,
	MemorySettingsStatus,
	MemoryStatus,
} from "../contracts";
import { readInputBudget, readSettings, writeSettings } from "../repository";
import type { ContextWindowStore } from "./context-window";
import type { createLedger } from "./ledger";

/** The host settings: the on/off switch and the input budget (spec/.archived/memory-recall-implementation-2026-11-23.md section 5). */
export function createMemorySettings(deps: {
	health: { healthy: boolean };
	windows: ContextWindowStore;
	ledger: Pick<
		ReturnType<typeof createLedger>,
		"skipUncuratedEventsInTransaction"
	>;
}) {
	const { health, windows, ledger } = deps;

	const statusInTransaction = (db: Database): MemorySettingsStatus => ({
		enabled: readSettings(db).enabled,
		healthy: health.healthy,
		...readInputBudget(db),
	});

	/**
	 * Saves the given settings (the ones left out stay). The switch steps the access policy's revision and expires the
	 * runs in flight; the input budget does neither (a saved answer's sources stay valid), and the window is built
	 * again from the budget it holds. Saving what is saved already changes nothing.
	 */
	function updateInTransaction(
		db: Database,
		patch: MemorySettingsInput,
	): MemorySettingsStatus {
		const current = {
			enabled: readSettings(db).enabled,
			...readInputBudget(db),
		};
		const next = { ...current };
		for (const [key, value] of Object.entries(patch))
			if (value !== undefined) Object.assign(next, { [key]: value });
		if (JSON.stringify(next) !== JSON.stringify(current)) {
			writeSettings(db, next);
			if (next.enabled !== current.enabled)
				windows.recordImmediateInTransaction(db, "settings", null);
			// What was said while memory was off is never learned.
			if (next.enabled && !current.enabled)
				ledger.skipUncuratedEventsInTransaction(db);
		}
		return statusInTransaction(db);
	}

	function setEnabledInTransaction(
		db: Database,
		enabled: boolean,
	): MemoryStatus {
		const { healthy } = updateInTransaction(db, { enabled });
		return { enabled, healthy };
	}

	return { statusInTransaction, updateInTransaction, setEnabledInTransaction };
}
