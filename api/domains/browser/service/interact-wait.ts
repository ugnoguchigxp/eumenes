/** A driver/provider ignoring abort must not retain a queue slot; its late result still meets saved guards. */
export function waitInteract<T>(
	work: Promise<T>,
	signal: AbortSignal,
): Promise<T> {
	return new Promise((resolve, reject) => {
		const abort = () =>
			reject(signal.reason ?? new Error("browser_interact_cancelled"));
		if (signal.aborted) abort();
		else signal.addEventListener("abort", abort, { once: true });
		work.then(
			(value) => {
				signal.removeEventListener("abort", abort);
				resolve(value);
			},
			(error) => {
				signal.removeEventListener("abort", abort);
				reject(error);
			},
		);
	});
}
