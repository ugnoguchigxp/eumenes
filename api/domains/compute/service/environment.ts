import type { Database } from "bun:sqlite";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import { waitForShared } from "../../../infrastructure/wait-for-shared";
import type { ComputePort } from "../contracts";
import { freshEnvironmentRow, saveEnvironment } from "../repository";
import { failure } from "./handlers";

// Keep the previous refresh cadence, leaving time for command translation before the saved environment expires.
const REFRESH_AFTER_MS = 60_000;

export function createEnvironmentDiscovery(
	store: SqliteStore,
	currentPort: () => ComputePort | null,
) {
	const pending = new Map<string, Promise<void>>();
	const shutdown = new AbortController();

	async function discover(port: ComputePort, binding: string) {
		let found: Awaited<ReturnType<ComputePort["discover"]>> | null = null;
		let error: string | null = null;
		try {
			found = await port.discover(
				AbortSignal.any([shutdown.signal, AbortSignal.timeout(15_000)]),
			);
		} catch (reason) {
			error = failure(reason).code;
		}
		if (shutdown.signal.aborted) return;
		await store.write((db) => {
			if (!shutdown.signal.aborted && currentPort()?.binding === binding)
				saveEnvironment(db, binding, found, error);
		});
	}
	return {
		canSelectInTransaction(db: Database) {
			const binding = currentPort()?.binding;
			return (
				binding !== undefined && !freshEnvironmentRow(db, binding)?.error_code
			);
		},
		needsDiscoveryInTransaction(db: Database) {
			const binding = currentPort()?.binding;
			return (
				binding !== undefined &&
				!freshEnvironmentRow(db, binding, REFRESH_AFTER_MS)
			);
		},
		async refresh(signal?: AbortSignal) {
			signal?.throwIfAborted();
			shutdown.signal.throwIfAborted();
			const port = currentPort();
			if (!port) return;
			const binding = port.binding;
			if (
				store.read((db) => freshEnvironmentRow(db, binding, REFRESH_AFTER_MS))
			)
				return;
			let work = pending.get(binding);
			if (!work) {
				work = discover(port, binding).finally(() => pending.delete(binding));
				pending.set(binding, work);
			}
			await waitForShared(
				work,
				signal ? AbortSignal.any([signal, shutdown.signal]) : shutdown.signal,
			);
		},
		async close() {
			shutdown.abort(new Error("compute_service_unavailable"));
			await Promise.allSettled(pending.values());
		},
	};
}
