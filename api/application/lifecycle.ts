import { getLogger } from "../infrastructure/logger";

/**
 * One named participant in process startup and shutdown. Every hook is
 * optional: an item may only recover, only start, or only close.
 */
export type Lifecycle = {
	name: string;
	/** Runs to completion before any `start`; a failure aborts startup. */
	recover?(): Promise<unknown>;
	start?(): void;
	/** May be synchronous. A throw is logged and never skips later items. */
	close?(): unknown;
};

type LifecycleLog = {
	error(event: string, fields: { reason: string }, error?: unknown): void;
};
type Timer = unknown;
const unref = (timer: unknown) => (timer as { unref?(): unknown }).unref?.();

export type LifecycleRunnerOptions = {
	log?: LifecycleLog;
	/** Injectable for tests; default is the global timer. */
	setTimer?: (callback: () => void, ms: number) => Timer;
	clearTimer?: (timer: Timer) => void;
};

/**
 * Items are registered in bring-up order. `recoverAll` and `startAll` walk
 * them in that order; `closeAll` walks them in reverse. An item that does not
 * define a hook is skipped for that phase, so an ordering that differs per
 * phase is expressed by registering the hooks as separate items.
 */
export function createLifecycleRunner(
	items: readonly Lifecycle[],
	options: LifecycleRunnerOptions = {},
) {
	const log: LifecycleLog = options.log ?? getLogger("server");
	const setTimer = options.setTimer ?? setTimeout;
	const clearTimer =
		options.clearTimer ?? ((timer: Timer) => clearTimeout(timer as never));
	return {
		async recoverAll(): Promise<void> {
			for (const item of items) await item.recover?.();
		},
		startAll(): void {
			for (const item of items) item.start?.();
		},
		/**
		 * Closes in reverse registration order. Each close runs in its own
		 * try/catch so a failure never skips later items. `deadlineMs` bounds the
		 * whole sequence: once it expires no further item is started and the
		 * result is false. Resolves true only when every close succeeded in time.
		 */
		async closeAll(deadlineMs: number): Promise<boolean> {
			let ok = true;
			let expired = false;
			let timer: Timer | undefined;
			const deadline = new Promise<"expired">((resolve) => {
				timer = setTimer(() => {
					expired = true;
					resolve("expired");
				}, deadlineMs);
			});
			const sequence = (async () => {
				for (const item of [...items].reverse()) {
					if (expired) return;
					if (!item.close) continue;
					try {
						await item.close();
					} catch (error) {
						ok = false;
						log.error(
							"server.shutdown_step_failed",
							{ reason: item.name },
							error,
						);
					}
				}
			})();
			const outcome = await Promise.race([
				sequence.then(() => "done"),
				deadline,
			]);
			if (timer) clearTimer(timer);
			if (outcome === "expired") {
				log.error("server.shutdown_timeout", { reason: "shutdown_timeout" });
				return false;
			}
			return ok;
		},
	};
}

export type IntervalLifecycle = Lifecycle & {
	/** Stops further ticks without waiting for a tick in flight. */
	stop(): void;
	/** Resolves when the tick in flight (if any) has finished. */
	idle(): Promise<void>;
};

/**
 * A periodic job. `start` arms the interval (unref'd, so it never keeps the
 * process alive); `close` is `stop` followed by `idle`. By default a tick is
 * skipped while the previous one is still running; `exclusive: false` fires
 * every tick and does not track it. A rejection from `run` is logged here.
 */
export function intervalLifecycle(
	name: string,
	ms: number,
	run: () => unknown,
	options: {
		exclusive?: boolean;
		setTimer?: (callback: () => void, ms: number) => Timer;
		clearTimer?: (timer: Timer) => void;
	} = {},
): IntervalLifecycle {
	const log = getLogger("server");
	const exclusive = options.exclusive ?? true;
	const set =
		options.setTimer ?? ((callback, delay) => setInterval(callback, delay));
	const clear =
		options.clearTimer ?? ((timer: Timer) => clearInterval(timer as never));
	let timer: Timer | undefined;
	let busy: Promise<void> | null = null;
	function tick() {
		if (exclusive && busy) return;
		const current = Promise.resolve()
			.then(run)
			.then(
				() => undefined,
				(error) => log.warn("server.interval_failed", { reason: name }, error),
			);
		if (!exclusive) return;
		busy = current.finally(() => {
			busy = null;
		});
	}
	const self: IntervalLifecycle = {
		name,
		start() {
			if (timer) return;
			timer = set(tick, ms);
			unref(timer);
		},
		stop() {
			if (timer) clear(timer);
			timer = undefined;
		},
		idle: async () => {
			await busy;
		},
		async close() {
			self.stop();
			await self.idle();
		},
	};
	return self;
}

type TerminatorOptions = {
	/** Resolves true when every shutdown step succeeded. */
	shutdown(): Promise<boolean>;
	/** Injectable `process.exit`. */
	exit(code: number): void;
	log: {
		warn(event: string, fields: { reason: string }): void;
		error(event: string, fields: { reason: string }, error?: unknown): void;
	};
	deadlineMs?: number;
	setTimer?: (callback: () => void, ms: number) => Timer;
};

/**
 * The signal handler. First call: start the shutdown with a hard process-level
 * deadline (exit 1), then exit 0 on success and 1 on any failure. A repeated
 * call while shutting down means the operator insists: exit 130 at once.
 */
export function createTerminator(options: TerminatorOptions): () => void {
	const setTimer = options.setTimer ?? setTimeout;
	let started = false;
	return () => {
		if (started) {
			options.log.warn("server.shutdown_forced", { reason: "second_signal" });
			options.exit(130);
			return;
		}
		started = true;
		const deadline = setTimer(() => {
			options.log.error("server.shutdown_timeout", {
				reason: "shutdown_timeout",
			});
			options.exit(1);
		}, options.deadlineMs ?? 30_000);
		unref(deadline);
		void options.shutdown().then(
			(ok) => options.exit(ok ? 0 : 1),
			(error) => {
				options.log.error(
					"server.shutdown_failed",
					{ reason: "shutdown_failed" },
					error,
				);
				options.exit(1);
			},
		);
	};
}

export type ProcessGuardOptions = {
	log: {
		error: (
			event: string,
			fields: Record<string, unknown>,
			error?: unknown,
		) => void;
	};
	/** Graceful process stop; the exit code is decided by the shutdown result. */
	terminate: () => void;
	now?: () => number;
	/** Rejections tolerated per window before the process is considered unhealthy. */
	maxRejections?: number;
	windowMs?: number;
};

/**
 * Last line of defence for fire-and-forget promises. A lone rejection is
 * logged and tolerated; a burst, or any uncaught exception, stops the process
 * gracefully. The error message is never put in the log fields.
 */
export function createProcessGuard(options: ProcessGuardOptions) {
	const now = options.now ?? Date.now;
	const max = options.maxRejections ?? 20;
	const windowMs = options.windowMs ?? 60_000;
	let times: number[] = [];
	return {
		onRejection(reason: unknown) {
			const at = now();
			times = times.filter((t) => at - t < windowMs);
			times.push(at);
			options.log.error(
				"process.unhandled_rejection",
				{ reason: "unhandled_rejection", count: times.length },
				reason,
			);
			if (times.length > max) options.terminate();
		},
		onException(error: unknown) {
			options.log.error(
				"process.uncaught_exception",
				{ reason: "uncaught_exception" },
				error,
			);
			options.terminate();
		},
	};
}
