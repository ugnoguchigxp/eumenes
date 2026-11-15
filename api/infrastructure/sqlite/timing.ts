import { getLogger } from "../logger";

const log = getLogger("sqlite");

/** Diagnose synchronous stalls without retaining SQL, arguments or callback results. */
export function measureStoreStep<T>(
	phase: "read" | "snapshot" | "write" | "commit_listener",
	operation: () => T,
	location?: Error,
): T {
	const started = performance.now();
	try {
		return operation();
	} finally {
		const durationMs = performance.now() - started;
		if (durationMs >= 50) {
			try {
				log.warn(
					"sqlite.slow_operation",
					{ phase, durationMs },
					location ?? new Error(),
				);
			} catch {
				// Diagnostics cannot change the result of a read or a committed write.
			}
		}
	}
}
