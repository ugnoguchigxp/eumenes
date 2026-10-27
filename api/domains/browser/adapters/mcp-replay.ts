import { BrowserDriverError } from "../contracts/ports";

/**
 * One replay call that returns only when the code has stopped. MCP's code tool ignores the cancel notification,
 * so on abort (the user's cancel or the time limit) the tab the code works on is closed, which makes its pending
 * Playwright calls fail; if the call has still not ended after the grace period, the child is ended, since
 * nothing else stops it. The caller holds the driver's serial section throughout, so no other call is sent.
 */
export async function runUntilStopped(call: {
	/** The index of the tab the code will work on, read before it starts; undefined when unknown. */
	currentTab: () => Promise<number | undefined>;
	/** Sends the code. `closing()` is true once the host itself is closing the page, whose error is then expected. */
	run: (closing: () => boolean) => Promise<unknown>;
	closeTab: (index: number) => Promise<unknown>;
	endSession: () => Promise<void>;
	graceMs: number;
	signal: AbortSignal;
}): Promise<void> {
	const tab = await call.currentTab();
	let stopping = false;
	const running = call.run(() => stopping);
	const ended = running.then(
		() => true,
		() => true,
	);
	const aborted = new Promise<false>((resolve) => {
		if (call.signal.aborted) resolve(false);
		else
			call.signal.addEventListener("abort", () => resolve(false), {
				once: true,
			});
	});
	if (await Promise.race([ended, aborted])) {
		// Errors reach the caller as a driver error code; the response text is dropped with the output files.
		await running;
		return;
	}
	stopping = true;
	const closed =
		tab === undefined
			? Promise.resolve(true)
			: call.closeTab(tab).then(
					() => true,
					() => true,
				);
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<false>((resolve) => {
		timer = setTimeout(() => resolve(false), call.graceMs);
	});
	const gone = await Promise.race([ended, deadline]);
	if (gone) await Promise.race([closed, deadline]);
	clearTimeout(timer);
	if (!gone) await call.endSession();
	throw new BrowserDriverError("cancelled", true);
}
