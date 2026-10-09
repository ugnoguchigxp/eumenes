import { expect, test } from "bun:test";
import { SCOPE, addMessage } from "./fixture";
import {
	assertionRows,
	candidate,
	mirrorRows,
	modelOutput,
	rigFor,
	runJob,
	type Call,
	type Rig,
	type SettleOutcomeOf,
} from "./extraction-fixture";
import { openLife, type Life } from "./lifecycle-fixture";
import { createForegroundHub, type ForegroundHub } from "..";
import { entityOp } from "./fixture";

// P4-03 / A44: foreground priority, cancel, resume. Fixture providers and an
// injected foreground signal only; the queue is the fixture queue (the real
// queue + real inference are in api/application/world-scheduling.test.ts).

const TEXT = "音声サービスは9月から利用できる。";
const utteranceId = (call: Call): string =>
	(
		JSON.parse(call.messages[1]!.content) as {
			utterances: { utteranceId: string }[];
		}
	).utterances[0]!.utteranceId;

async function ready(texts: string[] = [TEXT]) {
	const life = await openLife();
	expect((await life.lifecycle.recoverWorld()).status).toBe("open");
	expect((await life.world.apply(entityOp())).status).toBe("applied");
	for (const [i, text] of texts.entries())
		await addMessage(life, `m${i + 1}`, text);
	await life.lifecycle.consumeSourceChanges(SCOPE);
	return life;
}
const adopt = (call: Call) => modelOutput(candidate(TEXT, utteranceId(call)));

/** A model call that ends when aborted (the cancel is answered), after `answerMs`. */
function cancellable(answerMs: number) {
	return (call: Call) =>
		new Promise<string>((_resolve, reject) =>
			call.signal.addEventListener("abort", () => {
				if (answerMs === 0) reject(new Error("aborted"));
				else setTimeout(() => reject(new Error("aborted")), answerMs);
			}),
		);
}

function claimFor(rig: Rig, jobId: string, attempt: number) {
	const job = rig.jobs.get(jobId)!;
	job.state = "running";
	return {
		jobId,
		scope: "world",
		kind: job.kind,
		payloadVersion: 1,
		payload: job.payload as never,
		subjectRef: null,
		owner: "owner-1",
		attempt,
		generation: 0,
		maxAttempts: 2,
		deadlineAtMs: null,
	};
}
async function schedule(rig: Rig) {
	const scheduled = await rig.extraction.schedule(SCOPE);
	if (scheduled.status !== "scheduled") throw new Error("not scheduled");
	return scheduled.jobId;
}
const dependentCount = (life: Life) =>
	(
		life.store.read((db) =>
			db.query("SELECT COUNT(*) AS n FROM world_host_dependent").get(),
		) as { n: number }
	).n;
const settle = (
	rig: Rig,
	claim: ReturnType<typeof claimFor>,
	input: Parameters<Rig["extraction"]["handler"]["settleInTransaction"]>[2],
	outcome: SettleOutcomeOf,
) =>
	rig.life.store.write((db) =>
		rig.extraction.handler.settleInTransaction(db, claim, input, outcome),
	);
const prepare = (rig: Rig, claim: ReturnType<typeof claimFor>) =>
	rig.life.store.write((db) =>
		rig.extraction.handler.prepareInTransaction(db, claim),
	);
function withForeground(): { hub: ForegroundHub } {
	return { hub: createForegroundHub() };
}

test("A44 no input and no foreground: a periodic tick creates no job and no model request", async () => {
	const life = await openLife();
	try {
		expect((await life.lifecycle.recoverWorld()).status).toBe("open");
		expect((await life.world.apply(entityOp())).status).toBe("applied");
		const { hub } = withForeground();
		const rig = rigFor(life, adopt, { foreground: hub });
		for (let i = 0; i < 5; i++)
			expect(await rig.extraction.schedule(SCOPE)).toMatchObject({
				status: "idle",
				reason: "no_input",
			});
		expect(rig.jobs.size).toBe(0);
		expect(rig.inference.state.captured).toHaveLength(0);
		expect(rig.inference.state.executed).toBe(0);
	} finally {
		await life.cleanup();
	}
});

test("A44 foreground active: nothing is scheduled; the input waits and is scheduled when the foreground ends", async () => {
	const life = await ready();
	try {
		const { hub } = withForeground();
		const rig = rigFor(life, adopt, { foreground: hub });
		const end = hub.hold("asr");
		expect(await rig.extraction.schedule(SCOPE)).toMatchObject({
			status: "idle",
			reason: "foreground_active",
		});
		expect(rig.jobs.size).toBe(0);
		expect(rig.inference.state.captured).toHaveLength(0);
		expect(mirrorRows(life)[0]).toMatchObject({
			state: "received",
			job_id: null,
			failures: 0,
		});
		end();
		const jobId = await schedule(rig);
		const run = await runJob(rig, jobId);
		expect(run.outcome?.type).toBe("success");
		expect(assertionRows(life)).toHaveLength(1);
		expect(mirrorRows(life)[0]!.state).toBe("applied");
	} finally {
		await life.cleanup();
	}
});

test("A44 foreground starts after the job was queued: the claim is held un-run, the input keeps its place, a new attempt resumes it", async () => {
	const life = await ready();
	try {
		const { hub } = withForeground();
		const rig = rigFor(life, adopt, { foreground: hub });
		const first = await schedule(rig);
		const end = hub.hold("conversation");
		const run = await runJob(rig, first);
		expect(run.prepared).toMatchObject({
			status: "stale",
			reason: "foreground_active",
		});
		// Held, not failed: no model request, no dependents, no backoff, no failure.
		expect(rig.inference.state.captured).toHaveLength(0);
		expect(dependentCount(life)).toBe(0);
		expect(mirrorRows(life)[0]).toMatchObject({
			state: "received",
			job_id: null,
			manifest_id: null,
			request_id: null,
			failures: 0,
			retry_at_ms: 0,
		});
		end();
		const second = await schedule(rig);
		expect(second).not.toBe(first);
		expect((await runJob(rig, second)).outcome?.type).toBe("success");
		expect(assertionRows(life)).toHaveLength(1);
	} finally {
		await life.cleanup();
	}
});

test("A44 cancel answered at once: the running call ends, nothing is adopted, a NEW attempt takes the same input after the foreground", async () => {
	const life = await ready();
	try {
		const { hub } = withForeground();
		let calls = 0;
		const rig = rigFor(
			life,
			(call) => {
				calls += 1;
				return calls === 1 ? cancellable(0)(call) : adopt(call);
			},
			{ foreground: hub, stageBudgetMs: 5000, confirmMs: 1000 },
		);
		const jobId = await schedule(rig);
		const running = runJob(rig, jobId, { attempt: 1 });
		await Bun.sleep(20);
		const started = Date.now();
		const end = hub.hold("tts");
		const first = await running;
		expect(Date.now() - started).toBeLessThan(500);
		expect(first.outcome).toMatchObject({
			type: "retry",
			errorCode: "extract_foreground",
		});
		expect(assertionRows(life)).toHaveLength(0);
		expect(rig.extraction.slotBusy()).toBe(false);
		// The attempt left nothing behind and the input was not penalised.
		expect(dependentCount(life)).toBe(0);
		expect(rig.inference.state.cancelled).toContain("req-1");
		expect(mirrorRows(life)[0]).toMatchObject({
			state: "received",
			job_id: jobId,
			manifest_id: null,
			failures: 0,
		});
		// The queue retries the same job while the foreground still runs: held again.
		const retry = await runJob(rig, jobId, { attempt: 2 });
		expect(retry.prepared).toMatchObject({
			status: "stale",
			reason: "foreground_active",
		});
		expect(calls).toBe(1);
		end();
		const resumed = await schedule(rig);
		expect((await runJob(rig, resumed, { attempt: 1 })).outcome?.type).toBe(
			"success",
		);
		expect(calls).toBe(2);
		expect(assertionRows(life)).toHaveLength(1);
	} finally {
		await life.cleanup();
	}
});

test("A44 cancel answered late (within the confirmation window): still a clean cancel", async () => {
	const life = await ready();
	try {
		const { hub } = withForeground();
		const rig = rigFor(life, cancellable(60), {
			foreground: hub,
			stageBudgetMs: 5000,
			confirmMs: 500,
		});
		const jobId = await schedule(rig);
		const running = runJob(rig, jobId, { attempt: 1 });
		await Bun.sleep(20);
		const end = hub.hold("asr");
		const run = await running;
		expect(run.outcome).toMatchObject({
			type: "retry",
			errorCode: "extract_foreground",
		});
		expect(rig.extraction.slotBusy()).toBe(false);
		end();
	} finally {
		await life.cleanup();
	}
});

test("A44 cancel never answered: the slot stays held, no second call starts, the late provider end frees it and the input resumes", async () => {
	const life = await ready([TEXT, "別の話題の発言。"]);
	try {
		const { hub } = withForeground();
		let finish: (text: string) => void = () => {};
		let concurrent = 0;
		let peak = 0;
		const rig = rigFor(
			life,
			async (call) => {
				concurrent += 1;
				peak = Math.max(peak, concurrent);
				try {
					if (call.requestId === "req-1")
						return await new Promise<string>((resolve) => {
							finish = resolve;
						}); // ignores the abort
					return adopt(call);
				} finally {
					concurrent -= 1;
				}
			},
			{ foreground: hub, stageBudgetMs: 5000, confirmMs: 40 },
		);
		let freed = 0;
		rig.extraction.onSlotFree(() => {
			freed += 1;
		});
		const jobId = await schedule(rig);
		const running = runJob(rig, jobId, { attempt: 1 });
		await Bun.sleep(20);
		const end = hub.hold("conversation");
		const stuck = await running;
		expect(stuck.outcome).toMatchObject({
			type: "failed",
			errorCode: "extract_foreground_unconfirmed",
		});
		expect(rig.extraction.slotBusy()).toBe(true);
		// The foreground's fault, not the input's: no failure, no backoff.
		expect(
			mirrorRows(life).map((r) => [r.state, r.job_id, r.failures]),
		).toEqual([
			["received", null, 0],
			["received", null, 0],
		]);
		const executedBefore = rig.inference.state.executed;
		end();
		// The foreground is over, the slot is NOT: nothing is scheduled, nothing runs.
		expect(await rig.extraction.schedule(SCOPE)).toMatchObject({
			status: "idle",
			reason: "extract_slot_busy",
		});
		expect(rig.inference.state.executed).toBe(executedBefore);
		// A job that existed before the slot went busy is held at prepare too.
		const probe = {
			...claimFor(rig, jobId, 2),
		};
		const held = await prepare(rig, probe);
		expect(held).toMatchObject({
			status: "stale",
			reason: "extract_slot_busy",
		});
		expect(rig.inference.state.executed).toBe(executedBefore);
		// The provider finally ends the call: only now is the slot free.
		finish("{}");
		await Bun.sleep(10);
		expect(freed).toBe(1);
		expect(rig.extraction.slotBusy()).toBe(false);
		const next = await schedule(rig);
		expect((await runJob(rig, next)).outcome?.type).toBe("success");
		expect(peak).toBe(1);
		expect(assertionRows(life).length).toBeGreaterThan(0);
	} finally {
		await life.cleanup();
	}
});

test("A44 a late result from an OLD attempt is rejected at settle; the newer attempt alone is adopted", async () => {
	const life = await ready();
	try {
		const rig = rigFor(life, adopt);
		const jobId = await schedule(rig);
		const claim1 = claimFor(rig, jobId, 1);
		const prepared1 = await prepare(rig, claim1);
		if (prepared1.status !== "ready") throw new Error("not ready");
		const late = await rig.extraction.handler.execute(prepared1.input, {
			signal: new AbortController().signal,
			jobId,
			attempt: 1,
			generation: 0,
		});
		// The queue gave up on attempt 1 (lease lost / cancel): the job retries.
		await settle(rig, claim1, prepared1.input, {
			type: "retry",
			errorCode: "lease_expired",
			availableAtMs: 0,
		});
		const claim2 = claimFor(rig, jobId, 2);
		const prepared2 = await prepare(rig, claim2);
		if (prepared2.status !== "ready") throw new Error("not ready");
		expect(prepared2.input.requestId).not.toBe(prepared1.input.requestId);
		// Attempt 1's output arrives now.
		const stale = await settle(rig, claim1, prepared1.input, {
			type: "success",
			result: late,
		});
		expect(stale).toBe("stale");
		expect(assertionRows(life)).toHaveLength(0);
		expect(rig.inference.state.rejected).toContain("stale_attempt");
		// The newer attempt still holds its request and events and finishes normally.
		expect(mirrorRows(life)[0]).toMatchObject({
			state: "received",
			job_id: jobId,
			request_id: prepared2.input.requestId,
		});
		const out2 = await rig.extraction.handler.execute(prepared2.input, {
			signal: new AbortController().signal,
			jobId,
			attempt: 2,
			generation: 0,
		});
		expect(
			await settle(rig, claim2, prepared2.input, {
				type: "success",
				result: out2,
			}),
		).toBe("applied");
		expect(assertionRows(life)).toHaveLength(1);
		expect(mirrorRows(life)[0]!.state).toBe("applied");
	} finally {
		await life.cleanup();
	}
});

test("A44 a late result from a job that no longer owns the events is rejected without touching them", async () => {
	const life = await ready();
	try {
		const rig = rigFor(life, adopt);
		const oldJob = await schedule(rig);
		const claim1 = claimFor(rig, oldJob, 1);
		const prepared1 = await prepare(rig, claim1);
		if (prepared1.status !== "ready") throw new Error("not ready");
		const late = await rig.extraction.handler.execute(prepared1.input, {
			signal: new AbortController().signal,
			jobId: oldJob,
			attempt: 1,
			generation: 0,
		});
		// The old job was cancelled; its events went to a brand-new job.
		await life.store.write((db) =>
			rig.extraction.handler.cancelInTransaction(
				db,
				{
					jobId: oldJob,
					subjectRef: null,
					payload: rig.jobs.get(oldJob)!.payload as never,
				},
				"cancelled",
			),
		);
		rig.jobs.get(oldJob)!.state = "cancelled";
		const newJob = await schedule(rig);
		await settle(rig, claim1, prepared1.input, {
			type: "success",
			result: late,
		});
		expect(assertionRows(life)).toHaveLength(0);
		expect(mirrorRows(life)[0]).toMatchObject({
			state: "received",
			job_id: newJob,
		});
		expect((await runJob(rig, newJob)).outcome?.type).toBe("success");
		expect(assertionRows(life)).toHaveLength(1);
	} finally {
		await life.cleanup();
	}
});

test("A44 restart in the middle of an extraction: the checkpointed input is not lost and is extracted by a new process", async () => {
	const life = await ready();
	try {
		const first = rigFor(life, adopt);
		const jobId = await schedule(first);
		const claim = claimFor(first, jobId, 1);
		const prepared = await prepare(first, claim);
		expect(prepared.status).toBe("ready");
		expect(dependentCount(life)).toBeGreaterThan(0);
		// The process dies here: no settle, no cancel. A new process has no
		// in-flight call and a queue that no longer knows the job.
		const { hub } = withForeground();
		const second = rigFor(life, adopt, { foreground: hub });
		const end = hub.hold("asr");
		expect(await second.extraction.schedule(SCOPE)).toMatchObject({
			status: "idle",
			reason: "foreground_active",
		});
		expect(mirrorRows(life)[0]!.state).toBe("received");
		end();
		const next = await schedule(second);
		expect((await runJob(second, next)).outcome?.type).toBe("success");
		expect(assertionRows(life)).toHaveLength(1);
		expect(mirrorRows(life)[0]!.state).toBe("applied");
	} finally {
		await life.cleanup();
	}
});

test("A44 at most one Local extraction: a second job cannot start a call while one is in flight", async () => {
	const life = await ready();
	try {
		let concurrent = 0;
		let peak = 0;
		let release: (text: string) => void = () => {};
		const rig = rigFor(life, async (call) => {
			concurrent += 1;
			peak = Math.max(peak, concurrent);
			try {
				return await new Promise<string>((resolve) => {
					release = () => resolve(adopt(call));
				});
			} finally {
				concurrent -= 1;
			}
		});
		const jobId = await schedule(rig);
		const claim = claimFor(rig, jobId, 1);
		const prepared = await prepare(rig, claim);
		if (prepared.status !== "ready") throw new Error("not ready");
		const flying = rig.extraction.handler.execute(prepared.input, {
			signal: new AbortController().signal,
			jobId,
			attempt: 1,
			generation: 0,
		});
		await Bun.sleep(10);
		expect(rig.extraction.slotBusy()).toBe(true);
		// Neither a new schedule nor a direct second execute reaches the provider.
		expect(await rig.extraction.schedule(SCOPE)).toMatchObject({
			status: "idle",
		});
		await expect(
			rig.extraction.handler.execute(prepared.input, {
				signal: new AbortController().signal,
				jobId,
				attempt: 1,
				generation: 0,
			}),
		).rejects.toThrow("extract_slot_busy");
		release("");
		await flying;
		expect(peak).toBe(1);
		expect(rig.inference.state.executed).toBe(1);
	} finally {
		await life.cleanup();
	}
});

test("A44 a broken foreground signal reads as busy: background work yields, never runs by accident", async () => {
	const life = await ready();
	try {
		const rig = rigFor(life, adopt, {
			foreground: {
				active: () => {
					throw new Error("probe_failed");
				},
			},
		});
		expect(await rig.extraction.schedule(SCOPE)).toMatchObject({
			status: "idle",
			reason: "foreground_active",
		});
		expect(rig.jobs.size).toBe(0);
	} finally {
		await life.cleanup();
	}
});
