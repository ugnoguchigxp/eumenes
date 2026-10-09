import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../../infrastructure/sqlite";
import { createQueue, migration as queueMigration } from "../../queue";
import {
	attemptTimeoutMigration,
	createWebResearch,
	migration,
	type AcquisitionPort,
} from "..";
import type { ResearchResult } from "../contracts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
});
const response = (): ResearchResult => ({
	provider: "llm-fetch@0.1.2",
	observedAt: new Date(1000000).toISOString(),
	cache: "bypass",
	hits: [],
	failures: [],
	documents: [
		{
			url: "https://example.com/",
			title: "Example",
			text: "Evidence",
			fetchedAt: new Date(1000000).toISOString(),
			truncated: false,
			trust: "untrusted",
			tainted: true,
			verification: "source_read",
			guardDecision: "allow",
			guardReasonCodes: [],
		},
	],
});
function setup(execute: AcquisitionPort["execute"], capacity = 2) {
	const dir = mkdtempSync(join(tmpdir(), "web-attempt-"));
	const clock = { t: 1000000 };
	const store = openStore(join(dir, "main.db"), [
		queueMigration,
		migration,
		attemptTimeoutMigration,
	]);
	const queue = createQueue(store, {
		now: () => clock.t,
		resources: { "web.fetch": capacity },
	});
	const timers: { fn: () => void; ms: number; cleared: boolean }[] = [];
	const service = createWebResearch({
		store,
		queue,
		acquisition: { execute, async close() {} },
		now: () => clock.t,
		timers: {
			set: (fn, ms) => timers.push({ fn, ms, cleared: false }) - 1,
			clear: (h) => {
				timers[h as number]!.cleared = true;
			},
		},
	});
	cleanup.push(async () => {
		await queue.close(100);
		await service.close();
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	});
	return { store, queue, service, timers, clock };
}
const read = (url = "https://example.com/") => ({
	requestId: crypto.randomUUID(),
	operation: "read" as const,
	url,
	retention: "none" as const,
	freshness: "live" as const,
});
async function until(cond: () => boolean, tick: () => Promise<void>) {
	for (let i = 0; i < 150; i++) {
		await tick();
		if (cond()) return;
		await Bun.sleep(2);
	}
	throw new Error("condition timeout");
}
function submit(
	s: ReturnType<typeof setup>,
	attemptTimeoutMs?: number,
	url?: string,
) {
	return s.store.write((db) =>
		s.service.submitInTransaction(db, read(url), {
			deadlineAtMs: s.clock.t + 30000,
			lane: "background",
			attemptTimeoutMs,
		}),
	);
}

test("W01 attempt timer starts at execute, not while the job waits in Queue", async () => {
	const gates: (() => void)[] = [];
	const s = setup(
		() =>
			new Promise((resolve) =>
				gates.push(() => resolve({ result: response(), freshUntilMs: null })),
			),
		1,
	);
	const a = await submit(s, undefined, "https://a.example.com/");
	const b = await submit(s, 5000, "https://b.example.com/");
	await until(() => gates.length === 1, s.queue.tick);
	// b is queued behind a: no attempt timer exists yet, so waiting cannot fault it.
	expect(s.timers.length).toBe(0);
	s.clock.t += 10_000;
	gates[0]!();
	await until(
		() => s.service.get(a.runId)?.status === "completed",
		s.queue.tick,
	);
	await until(() => gates.length === 2, s.queue.tick);
	expect(s.timers.map((t) => t.ms)).toEqual([5000]);
	gates[1]!();
	await until(
		() => s.service.get(b.runId)?.status === "completed",
		s.queue.tick,
	);
	expect(s.timers[0]!.cleared).toBe(true);
});

test("W01 attempt timeout is web_attempt_timeout, single HTTP attempt, and success after a slow-but-in-time fetch is not expired", async () => {
	let calls = 0;
	const s = setup(() => {
		calls++;
		return new Promise(() => {});
	});
	const run = await submit(s, 5000);
	await until(() => s.timers.length === 1, s.queue.tick);
	s.timers[0]!.fn();
	await until(
		() => s.service.get(run.runId)?.status === "failed",
		s.queue.tick,
	);
	expect(s.service.get(run.runId)?.errorCode).toBe("web_attempt_timeout");
	expect(calls).toBe(1);

	const ok = setup(async () => ({ result: response(), freshUntilMs: null }));
	const fast = await submit(ok, 5000);
	await until(
		() => ok.service.get(fast.runId)?.status === "completed",
		ok.queue.tick,
	);
	// A late timer callback after completion cannot turn the result into a failure.
	ok.timers[0]!.fn();
	ok.clock.t += 4000;
	expect(ok.service.get(fast.runId)?.status).toBe("completed");
	expect(ok.service.get(fast.runId)?.errorCode).toBeNull();
});

test("W01 a shared fetch survives when only one consumer times out; last consumer leaving aborts it", async () => {
	let signal!: AbortSignal;
	let resolve!: (v: { result: ResearchResult; freshUntilMs: null }) => void;
	let calls = 0;
	const s = setup((_r, sig) => {
		calls++;
		signal = sig;
		return new Promise((r) => (resolve = r));
	});
	const impatient = await submit(s, 5000);
	const patient = await submit(s);
	await until(() => s.timers.length === 1 && calls >= 1, s.queue.tick);
	s.timers[0]!.fn();
	await until(
		() => s.service.get(impatient.runId)?.status === "failed",
		s.queue.tick,
	);
	expect(s.service.get(impatient.runId)?.errorCode).toBe("web_attempt_timeout");
	expect(signal.aborted).toBe(false);
	resolve({ result: response(), freshUntilMs: null });
	await until(
		() => s.service.get(patient.runId)?.status === "completed",
		s.queue.tick,
	);
	expect(calls).toBe(1);

	const lone = setup((_r, sig) => {
		signal = sig;
		return new Promise(() => {});
	});
	const only = await submit(lone, 5000);
	await until(() => lone.timers.length === 1, lone.queue.tick);
	lone.timers[0]!.fn();
	await until(
		() => lone.service.get(only.runId)?.status === "failed",
		lone.queue.tick,
	);
	expect(signal.aborted).toBe(true);
});

test("W01 cancellation stays web_cancelled and invalid timeouts are rejected; default timeout path is unchanged", async () => {
	const s = setup(() => new Promise(() => {}));
	await expect(submit(s, 0)).rejects.toThrow("invalid_web_attempt_timeout");
	await expect(submit(s, 15001)).rejects.toThrow("invalid_web_attempt_timeout");
	const run = await submit(s);
	await until(() => s.queue.get(run.jobId)?.state === "running", s.queue.tick);
	expect(s.timers.length).toBe(0);
	await s.service.cancel(run.runId);
	expect(s.service.get(run.runId)?.status).toBe("cancelled");
	expect(s.service.get(run.runId)?.errorCode).toBe("cancel_requested");
});
