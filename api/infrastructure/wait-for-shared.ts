/** Cancels this wait without cancelling work shared by other callers. */
export async function waitForShared<T>(work: Promise<T>, signal: AbortSignal) {
	const { promise, reject } = Promise.withResolvers<never>();
	const abort = () => reject(signal.reason);
	signal.addEventListener("abort", abort, { once: true });
	if (signal.aborted) abort();
	try {
		const value = await Promise.race([work, promise]);
		signal.throwIfAborted();
		return value;
	} finally {
		signal.removeEventListener("abort", abort);
	}
}
