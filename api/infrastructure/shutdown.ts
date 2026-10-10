/** Budget for the lifecycle runner's closeAll. */
export const SHUTDOWN_DEADLINE_MS = 30_000;
/** Process-level backstop: the runner's own deadline normally fires first. */
export const PROCESS_SHUTDOWN_DEADLINE_MS = SHUTDOWN_DEADLINE_MS + 5_000;

/**
 * Tracks the startup step in flight so a shutdown that begins mid-startup can
 * wait for it to settle before closing, instead of racing it.
 */
export function createStartupGate() {
	let starting: Promise<unknown> = Promise.resolve();
	return {
		/** Runs one startup step; the step's own result and failure pass through. */
		step<T>(work: () => Promise<T> | T): Promise<T> {
			const promise = Promise.resolve().then(work);
			// Shutdown only needs "settled", not success.
			starting = promise.catch(() => {});
			return promise;
		},
		/** Resolves once the most recent step has settled, whether it failed or not. */
		async settled(): Promise<void> {
			await starting;
		},
	};
}
