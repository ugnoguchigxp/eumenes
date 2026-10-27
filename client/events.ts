import { readSse } from "./sse";
import { ApiError, type Transport } from "./transport";

const pause = (ms: number, signal: AbortSignal) =>
	new Promise<void>((resolve) => {
		if (signal.aborted) {
			resolve();
			return;
		}
		const finish = () => {
			clearTimeout(timer);
			signal.removeEventListener("abort", finish);
			resolve();
		};
		const timer = setTimeout(finish, ms);
		signal.addEventListener("abort", finish, { once: true });
	});

/** `reset` means missed events: consumers must resynchronize everything. */
export type ChangeKind = "change" | "reset";

export function eventsClient(
	transport: Transport,
	options: { retryMs?: number; idleMs?: number } = {},
) {
	const listeners = new Set<(kind: ChangeKind) => void>();
	const stateListeners = new Set<() => void>();
	let state: "idle" | "connecting" | "connected" | "failed" = "idle";
	function setState(next: typeof state) {
		if (state === next) return;
		state = next;
		for (const listener of stateListeners) {
			try {
				listener();
			} catch {
				/* Independent observers. */
			}
		}
	}
	let connection: AbortController | undefined;
	let lastId: string | undefined;
	// Credentials or origin were refused: only an explicit reconnect may try again.
	let authRefused = false;
	const notify = (kind: ChangeKind) => {
		for (const listener of listeners) {
			try {
				listener(kind);
			} catch {
				/* A listener cannot close the shared stream. */
			}
		}
	};
	async function run(lifetime: AbortController) {
		let failures = 0;
		while (!lifetime.signal.aborted) {
			if (failures === 0) setState("connecting");
			try {
				await readSse(
					(signal) =>
						transport.call("/api/events", {
							headers: {
								Accept: "text/event-stream",
								...(lastId ? { "Last-Event-ID": lastId } : {}),
							},
							signal,
						}),
					{
						signal: lifetime.signal,
						connectMs: 10_000,
						idleMs: options.idleMs ?? 45_000,
						maxFrame: 65_536,
						errors: {
							invalid: "invalid_event_stream",
							tooLarge: "event_frame_too_large",
						},
						onEvent({ event, id }) {
							if (
								event !== "reset" &&
								event !== "change" &&
								event !== "resumed"
							)
								return;
							if (id) lastId = id;
							failures = 0;
							authRefused = false;
							setState("connected");
							// "resumed" proves nothing was missed: no invalidation.
							if (event !== "resumed")
								notify(event === "reset" ? "reset" : "change");
						},
					},
				);
			} catch (error) {
				if (!lifetime.signal.aborted && connection === lifetime)
					setState("failed");
				// A missing endpoint may come back after a restart or deploy, so focus or
				// reconnection retries it. Refused credentials stay failed until repaired.
				if (error instanceof ApiError && [401, 403].includes(error.status)) {
					authRefused = true;
					break;
				}
				if (error instanceof ApiError && error.status === 404) break;
			}
			if (lifetime.signal.aborted) break;
			setState("failed");
			// Refresh once on connection loss so the existing error/reconnect UI stays useful.
			if (failures === 0) notify("reset");
			await pause(
				Math.min(
					(options.retryMs ?? 5000) * 2 ** Math.min(failures++, 3),
					30_000,
				),
				lifetime.signal,
			);
		}
		if (connection === lifetime) connection = undefined;
	}
	function restart() {
		connection?.abort();
		connection = undefined;
		if (listeners.size) {
			connection = new AbortController();
			void run(connection);
		}
	}
	// Coming back to the page or the network retries a stream that is not live.
	let resumeTimer: ReturnType<typeof setTimeout> | undefined;
	function resume() {
		if (
			typeof document !== "undefined" &&
			document.visibilityState === "hidden"
		)
			return;
		clearTimeout(resumeTimer);
		resumeTimer = setTimeout(() => {
			if (state === "connected" || authRefused || !listeners.size) return;
			restart();
		}, 100);
	}
	const canWatch = typeof window !== "undefined" && !!window.addEventListener;
	function watchResume() {
		if (!canWatch) return;
		window.addEventListener("focus", resume);
		window.addEventListener("online", resume);
		document.addEventListener("visibilitychange", resume);
	}
	function unwatchResume() {
		if (!canWatch) return;
		clearTimeout(resumeTimer);
		window.removeEventListener("focus", resume);
		window.removeEventListener("online", resume);
		document.removeEventListener("visibilitychange", resume);
	}
	return {
		changesState: () => state,
		subscribeChangesState(listener: () => void) {
			stateListeners.add(listener);
			return () => {
				stateListeners.delete(listener);
			};
		},
		reconnectChanges(options?: { force?: boolean }) {
			if (!options?.force && state === "connected") return;
			authRefused = false;
			restart();
		},
		subscribeChanges(listener: (kind: ChangeKind) => void) {
			if (!listeners.size) watchResume();
			listeners.add(listener);
			if (!connection) {
				connection = new AbortController();
				void run(connection);
			}
			return () => {
				listeners.delete(listener);
				if (!listeners.size)
					queueMicrotask(() => {
						if (!listeners.size) {
							unwatchResume();
							connection?.abort();
							connection = undefined;
							setState("idle");
						}
					});
			};
		},
	};
}
