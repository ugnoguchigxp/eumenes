import { expect, test } from "bun:test";
import {
	createLifecycleRunner,
	createProcessGuard,
	createTerminator,
	intervalLifecycle,
	type Lifecycle,
} from "./lifecycle";

/** Timers fired by hand: no real waiting. */
function manualTimers() {
	const pending: Array<{ callback: () => void; ms: number; cleared: boolean }> =
		[];
	return {
		pending,
		set(callback: () => void, ms: number) {
			const entry = { callback, ms, cleared: false };
			pending.push(entry);
			return Object.assign(entry, { unref() {} });
		},
		clear(timer: unknown) {
			(timer as { cleared: boolean }).cleared = true;
		},
		fire(index = 0) {
			const entry = pending[index]!;
			if (!entry.cleared) entry.callback();
		},
	};
}
function recordingLog() {
	const errors: Array<{ event: string; reason: string }> = [];
	return {
		errors,
		log: {
			error: (event: string, fields: { reason: string }) =>
				void errors.push({ event, reason: fields.reason }),
		},
	};
}
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

test("recover and start follow registration order; close is the reverse", async () => {
	const events: string[] = [];
	const items: Lifecycle[] = ["a", "b", "c"].map((name) => ({
		name,
		recover: async () => void events.push(`recover:${name}`),
		start: () => void events.push(`start:${name}`),
		close: async () => void events.push(`close:${name}`),
	}));
	const runner = createLifecycleRunner(items);
	await runner.recoverAll();
	runner.startAll();
	expect(await runner.closeAll(1000)).toBe(true);
	expect(events).toEqual([
		"recover:a",
		"recover:b",
		"recover:c",
		"start:a",
		"start:b",
		"start:c",
		"close:c",
		"close:b",
		"close:a",
	]);
});

test("items without a hook are skipped, so per-phase order is expressed as separate items", async () => {
	const events: string[] = [];
	const runner = createLifecycleRunner([
		{ name: "r1", recover: async () => void events.push("r1") },
		{ name: "r2", recover: async () => void events.push("r2") },
		{ name: "s1", start: () => void events.push("s1") },
		{ name: "c1", close: () => void events.push("c1") },
		{ name: "c2", close: () => void events.push("c2") },
	]);
	await runner.recoverAll();
	runner.startAll();
	await runner.closeAll(1000);
	expect(events).toEqual(["r1", "r2", "s1", "c2", "c1"]);
});

test("a recover failure aborts startup and stops later recoveries", async () => {
	const events: string[] = [];
	const runner = createLifecycleRunner([
		{ name: "a", recover: async () => void events.push("a") },
		{
			name: "b",
			recover: async () => {
				throw new Error("boom");
			},
		},
		{ name: "c", recover: async () => void events.push("c") },
	]);
	await expect(runner.recoverAll()).rejects.toThrow("boom");
	expect(events).toEqual(["a"]);
});

test("a failing close is logged by name and never skips the rest; the result is false", async () => {
	const events: string[] = [];
	const { errors, log } = recordingLog();
	const runner = createLifecycleRunner(
		[
			{ name: "store", close: () => void events.push("store") },
			{
				name: "async_fail",
				close: async () => {
					throw new Error("async");
				},
			},
			{
				name: "sync_fail",
				close: () => {
					throw new Error("sync");
				},
			},
			{ name: "first", close: () => void events.push("first") },
		],
		{ log },
	);
	expect(await runner.closeAll(1000)).toBe(false);
	expect(events).toEqual(["first", "store"]);
	expect(errors).toEqual([
		{ event: "server.shutdown_step_failed", reason: "sync_fail" },
		{ event: "server.shutdown_step_failed", reason: "async_fail" },
	]);
});

test("the overall deadline abandons a hung close, starts nothing further, and reports failure", async () => {
	const timers = manualTimers();
	const events: string[] = [];
	const { errors, log } = recordingLog();
	const runner = createLifecycleRunner(
		[
			{ name: "store", close: () => void events.push("store") },
			{ name: "hung", close: () => new Promise(() => {}) },
			{ name: "first", close: () => void events.push("first") },
		],
		{ log, setTimer: timers.set, clearTimer: timers.clear },
	);
	const closing = runner.closeAll(30_000);
	await flush();
	expect(timers.pending[0]!.ms).toBe(30_000);
	expect(events).toEqual(["first"]);
	timers.fire();
	expect(await closing).toBe(false);
	expect(events).toEqual(["first"]);
	expect(errors).toEqual([
		{ event: "server.shutdown_timeout", reason: "shutdown_timeout" },
	]);
});

test("a close that finishes in time clears its deadline timer", async () => {
	const timers = manualTimers();
	const runner = createLifecycleRunner([{ name: "a", close: () => {} }], {
		setTimer: timers.set,
		clearTimer: timers.clear,
	});
	expect(await runner.closeAll(5)).toBe(true);
	expect(timers.pending[0]!.cleared).toBe(true);
});

test("intervalLifecycle skips a tick while the previous one runs, and close waits for it", async () => {
	const timers = manualTimers();
	let release = () => {};
	let runs = 0;
	const job = intervalLifecycle(
		"job",
		1000,
		() => {
			runs++;
			return new Promise<void>((resolve) => {
				release = resolve;
			});
		},
		{ setTimer: timers.set, clearTimer: timers.clear },
	);
	job.start?.();
	expect(timers.pending[0]!.ms).toBe(1000);
	timers.pending[0]!.callback();
	await flush();
	timers.pending[0]!.callback();
	await flush();
	expect(runs).toBe(1);
	let closed = false;
	const closing = Promise.resolve(job.close?.()).then(() => {
		closed = true;
	});
	expect(timers.pending[0]!.cleared).toBe(true);
	await flush();
	expect(closed).toBe(false);
	release();
	await closing;
	expect(closed).toBe(true);
	// After the tick finished a new one may run again.
	timers.pending[0]!.callback();
	await flush();
	expect(runs).toBe(2);
	release();
});

test("intervalLifecycle stop and idle can be used apart, and a rejecting job is contained", async () => {
	const timers = manualTimers();
	let release = () => {};
	const job = intervalLifecycle(
		"job",
		10,
		() =>
			new Promise<void>((_, reject) => {
				release = () => reject(new Error("tick failed"));
			}),
		{ setTimer: timers.set, clearTimer: timers.clear },
	);
	job.start?.();
	timers.pending[0]!.callback();
	await flush();
	job.stop();
	expect(timers.pending[0]!.cleared).toBe(true);
	let idle = false;
	const waiting = job.idle().then(() => {
		idle = true;
	});
	await flush();
	expect(idle).toBe(false);
	release();
	await waiting;
	expect(idle).toBe(true);
});

test("a non-exclusive interval fires every tick and does not track them", async () => {
	const timers = manualTimers();
	let runs = 0;
	const job = intervalLifecycle(
		"beat",
		10,
		() => {
			runs++;
			return new Promise(() => {});
		},
		{ exclusive: false, setTimer: timers.set, clearTimer: timers.clear },
	);
	job.start?.();
	timers.pending[0]!.callback();
	timers.pending[0]!.callback();
	await flush();
	expect(runs).toBe(2);
	await job.idle();
});

function terminatorHarness(shutdown: () => Promise<boolean>) {
	const timers = manualTimers();
	const exits: number[] = [];
	const logs: string[] = [];
	const terminate = createTerminator({
		shutdown,
		exit: (code) => void exits.push(code),
		log: {
			warn: (event, fields) => void logs.push(`${event}:${fields.reason}`),
			error: (event, fields) => void logs.push(`${event}:${fields.reason}`),
		},
		setTimer: timers.set,
	});
	return { timers, exits, logs, terminate };
}

test("terminator: a successful shutdown exits 0 and a failed one exits 1", async () => {
	const ok = terminatorHarness(async () => true);
	ok.terminate();
	await flush();
	expect(ok.exits).toEqual([0]);
	const failed = terminatorHarness(async () => false);
	failed.terminate();
	await flush();
	expect(failed.exits).toEqual([1]);
	const thrown = terminatorHarness(async () => {
		throw new Error("x");
	});
	thrown.terminate();
	await flush();
	expect(thrown.exits).toEqual([1]);
	expect(thrown.logs).toEqual(["server.shutdown_failed:shutdown_failed"]);
});

test("terminator: a second signal while shutting down exits 130 at once", async () => {
	let calls = 0;
	const hung = terminatorHarness(() => {
		calls++;
		return new Promise(() => {});
	});
	hung.terminate();
	await flush();
	expect(hung.exits).toEqual([]);
	hung.terminate();
	expect(hung.exits).toEqual([130]);
	expect(hung.logs).toEqual(["server.shutdown_forced:second_signal"]);
	expect(calls).toBe(1);
});

test("terminator: the 30 s process deadline exits 1 when shutdown never finishes", async () => {
	const hung = terminatorHarness(() => new Promise(() => {}));
	hung.terminate();
	expect(hung.timers.pending).toHaveLength(1);
	expect(hung.timers.pending[0]!.ms).toBe(30_000);
	hung.timers.fire();
	expect(hung.exits).toEqual([1]);
	expect(hung.logs).toEqual(["server.shutdown_timeout:shutdown_timeout"]);
});

function guardHarness(maxRejections?: number) {
	let clock = 0;
	const logs: Array<{ event: string; fields: Record<string, unknown> }> = [];
	let terminated: unknown[][] = [];
	const guard = createProcessGuard({
		log: { error: (event, fields) => logs.push({ event, fields }) },
		terminate: (...args: unknown[]) => {
			terminated.push(args);
		},
		now: () => clock,
		maxRejections,
	});
	return {
		guard,
		logs,
		terminated: () => terminated,
		advance: (ms: number) => {
			clock += ms;
		},
	};
}

test("process guard: one rejection is logged and tolerated", () => {
	const h = guardHarness();
	h.guard.onRejection(new Error("x"));
	expect(h.logs).toHaveLength(1);
	expect(h.logs[0]!.event).toBe("process.unhandled_rejection");
	expect(h.logs[0]!.fields.reason).toBe("unhandled_rejection");
	expect(h.terminated()).toHaveLength(0);
});

test("process guard: more than 20 rejections in one window terminate; spread-out ones do not", () => {
	const burst = guardHarness();
	for (let i = 0; i < 20; i++) burst.guard.onRejection(new Error("x"));
	expect(burst.terminated()).toHaveLength(0);
	burst.guard.onRejection(new Error("x"));
	expect(burst.terminated()).toHaveLength(1);

	const spread = guardHarness();
	for (let i = 0; i < 40; i++) {
		spread.guard.onRejection(new Error("x"));
		spread.advance(10_000);
	}
	expect(spread.terminated()).toHaveLength(0);
});

test("process guard: an uncaught exception always terminates, without arguments", () => {
	const h = guardHarness();
	h.guard.onException(new Error("boom"));
	expect(h.terminated()).toEqual([[]]);
	expect(h.logs[0]!.event).toBe("process.uncaught_exception");
});

test("process guard: log fields never carry the error text", () => {
	const h = guardHarness();
	h.guard.onRejection(new Error("secret-text"));
	h.guard.onException(new Error("secret-text"));
	expect(JSON.stringify(h.logs.map((l) => l.fields))).not.toContain(
		"secret-text",
	);
});
