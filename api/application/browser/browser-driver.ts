import {
	BrowserDriverError,
	type BrowserDriver,
	type DriverConnectionState,
} from "../../domains/browser";

/**
 * The domain's driver port has no executable-path argument, and the saved path may change between
 * two connections. Each `connect` builds a fresh driver with the path saved at that moment; every
 * other call goes to that driver, and its state changes are passed on. A driver that was replaced
 * (or closed) reports nothing any more.
 */
export function createSavedPathDriver(options: {
	/** The saved Brave executable at the moment of connecting. */
	executablePath: () => string | undefined;
	create: (executablePath: string | undefined) => BrowserDriver;
}): BrowserDriver & { close(): Promise<void> } {
	const listeners = new Set<(state: DriverConnectionState) => void>();
	let live: BrowserDriver | null = null;
	let unsubscribe: (() => void) | null = null;
	let closed = false;
	let last: DriverConnectionState = { state: "disconnected" };

	const emit = (state: DriverConnectionState) => {
		last = state;
		if (closed) return;
		for (const listener of listeners) {
			try {
				listener(state);
			} catch {
				// A failing listener must not break the driver.
			}
		}
	};
	const current = (): BrowserDriver => {
		if (!live) throw new BrowserDriverError("browser_disconnected", false);
		return live;
	};
	const release = () => {
		unsubscribe?.();
		unsubscribe = null;
		live = null;
	};

	return {
		async connect(signal) {
			if (closed) return { state: "disconnected", reason: "user" };
			if (live && live.state().state !== "disconnected")
				return live.connect(signal);
			const old = live;
			release();
			await old?.disconnect().catch(() => undefined);
			const driver = options.create(options.executablePath());
			live = driver;
			unsubscribe = driver.onStateChange((state) => {
				if (live === driver) emit(state);
			});
			return driver.connect(signal);
		},
		async disconnect() {
			await live?.disconnect();
		},
		state: () => (live ? live.state() : last),
		onStateChange(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		listTabs: async () => current().listTabs(),
		selectTab: async (index) => current().selectTab(index),
		newTab: async (url) => current().newTab(url),
		closeTab: async (index) => current().closeTab(index),
		snapshot: async (signal) => current().snapshot(signal),
		act: async (action, signal) => current().act(action, signal),
		runReplay: async (code, signal) => current().runReplay(code, signal),
		inspectTarget: async (ref) => current().inspectTarget(ref),
		inspectFocused: async () => current().inspectFocused(),
		measure: async (range, elementRef) => current().measure(range, elementRef),
		screenshot: async (range, elementRef, signal) =>
			current().screenshot(range, elementRef, signal),
		/** Stops the child without reporting: the process is going away. */
		async close() {
			closed = true;
			const driver = live;
			release();
			await driver?.disconnect().catch(() => undefined);
		},
	};
}
