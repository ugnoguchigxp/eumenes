import type { LogFields } from "./logger";

/** The part of a logger that `ignoreError` needs; `error` is kept for loggers that record frames. */
export interface DebugLog {
	debug: (event: string, fields?: LogFields, error?: unknown) => void;
}

/**
 * Handler for a failure that is deliberately not propagated (best-effort cleanup, optional
 * notification). It leaves a debug trace so the cause can still be found: pass it to `.catch(...)`.
 */
export function ignoreError(
	log: DebugLog,
	event: string,
	reason: string,
): (error: unknown) => void {
	return (error) => log.debug(event, { reason }, error);
}
