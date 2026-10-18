import { wait } from "./guards";
import type { Lease } from "./profiles";

/** Let in-flight work finish (up to 5 seconds) before the final release. */
export async function drainLease(current: Lease) {
	const idle = new AbortController().signal;
	for (let waited = 0; current.useCount > 0 && waited < 5_000; waited += 100)
		await wait(100, idle);
}
