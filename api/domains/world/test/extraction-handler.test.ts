import { expect, test } from "bun:test";
import { SCOPE, addMessage, entityOp, keyOf, worldEdges } from "./fixture";
import {
	assertionRows,
	candidate,
	drain,
	inboxRows,
	mirrorRows,
	modelOutput,
	rigFor,
	runJob,
	type Call,
	type Rig,
} from "./extraction-fixture";
import { memoryForgetSource, openLife, type Life } from "./lifecycle-fixture";

// P4-02: the Local extraction queue handler, driven with fixture providers
// only. A19 (candidate adoption), A20 (window and manifest limits),
// A43 (invalid output, timeout, registration refusal, Local only).

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
const lastReport = (rig: Rig) =>
	rig.reports.at(-1) as {
		disposition: string;
		reasons: string[];
		accepted: number;
		held: number;
		rejected: number;
	};
const dependents = (life: Life) =>
	worldEdges(life).filter((e) => e.dependent_id.includes(":w1m-"));
const manifests = (life: Life) =>
	life.store.read((db) =>
		db.query("SELECT manifest_id, status FROM world_input_manifest").all(),
	) as { manifest_id: string; status: string }[];

test("A19 a valid candidate becomes a CANDIDATE claim with host-assigned ids, a manifest and Memory dependents", async () => {
	const life = await ready();
	try {
		const rig = rigFor(life, (call) =>
			modelOutput(candidate(TEXT, utteranceId(call))),
		);
		await drain(rig);
		expect(lastReport(rig)).toMatchObject({
			disposition: "adopted",
			accepted: 1,
		});
		const claims = assertionRows(life);
		expect(claims).toHaveLength(1);
		// Ids are the host's, the lifecycle is never active, the origin is the utterance's.
		expect(claims[0]!.id.startsWith("ax-")).toBe(true);
		expect(claims[0]).toMatchObject({
			lifecycle: "candidate",
			origin: "user_report",
			revision: 1,
		});
		expect(manifests(life)).toEqual([
			{
				manifest_id: expect.stringMatching(/^xm-/) as unknown as string,
				status: "applied",
			},
		]);
		expect(dependents(life).length).toBeGreaterThan(0);
		expect(mirrorRows(life)[0]).toMatchObject({
			state: "applied",
			job_id: null,
			manifest_id: null,
			request_id: null,
		});
		expect(inboxRows(life).map((r) => r.status)).toEqual(["applied"]);
		expect(rig.inference.state.accepted).toBe(1);
		// The job is the queue's: background lane, the LLM slot, two attempts.
		const job = [...rig.jobs.values()][0]!;
		expect(job).toMatchObject({
			kind: "world.extract",
			lane: "background",
			resourceKey: "inference.llm",
			maxAttempts: 2,
		});
	} finally {
		await life.cleanup();
	}
});

test("A19 type and meaning checks: negated, hypothetical, question, model ids, unknown subjects and bad quotes are not adopted", async () => {
	const cases: {
		name: string;
		make: (id: string) => Record<string, unknown>;
		code: string;
		adopted?: "model_hypothesis" | "user_report";
	}[] = [
		{
			name: "negated",
			make: (id) => candidate(TEXT, id, { modality: "negated" }),
			code: "NEGATED_NOT_FACT",
		},
		{
			name: "hypothetical",
			make: (id) => candidate(TEXT, id, { modality: "hypothetical" }),
			code: "HYPOTHETICAL_NOT_FACT",
		},
		{
			name: "question",
			make: (id) => candidate(TEXT, id, { modality: "question" }),
			code: "QUESTION_NOT_CLAIM",
		},
		{
			name: "model id",
			make: (id) => candidate(TEXT, id, { id: "model-chosen" }),
			code: "FORBIDDEN_MODEL_FIELD",
		},
		{
			name: "model status",
			make: (id) =>
				candidate(TEXT, id, { status: "active", lifecycle: "active" }),
			code: "FORBIDDEN_MODEL_FIELD",
		},
		{
			name: "model confidence",
			make: (id) => candidate(TEXT, id, { confidence: 0.99 }),
			code: "FORBIDDEN_MODEL_FIELD",
		},
		{
			name: "unknown subject id",
			make: (id) =>
				candidate(TEXT, id, { subject: { kind: "id", id: "ghost" } }),
			code: "UNKNOWN_SUBJECT_ID",
		},
		{
			name: "unresolved alias is held",
			make: (id) =>
				candidate(TEXT, id, { subject: { kind: "alias", text: "未知" } }),
			code: "SUBJECT_UNRESOLVED",
		},
		{
			name: "quote of an utterance outside the window",
			make: () => candidate(TEXT, "not-in-window"),
			code: "QUOTE_SOURCE_NOT_IN_WINDOW",
		},
		{
			name: "quote beyond the text",
			make: (id) =>
				candidate(TEXT, id, {
					quote: { utteranceId: id, startByte: 0, endByte: 9999 },
				}),
			code: "QUOTE_OUT_OF_RANGE",
		},
		{
			name: "reported speech is a hypothesis",
			make: (id) => candidate(TEXT, id, { modality: "reported" }),
			code: "",
			adopted: "model_hypothesis",
		},
		{
			name: "asserted is a user report",
			make: (id) => candidate(TEXT, id),
			code: "",
			adopted: "user_report",
		},
	];
	const life = await ready([]);
	try {
		let adopted = 0;
		for (const [i, c] of cases.entries()) {
			await addMessage(life, `t${i}`, TEXT);
			await life.lifecycle.consumeSourceChanges(SCOPE);
			const known = new Set(assertionRows(life).map((r) => r.id));
			const rig = rigFor(life, (call) =>
				modelOutput(c.make(utteranceId(call))),
			);
			await drain(rig);
			const report = lastReport(rig);
			expect(report.disposition).toBe("adopted");
			if (c.adopted) {
				adopted += 1;
				expect(report.accepted).toBe(1);
				const added = assertionRows(life).filter((r) => !known.has(r.id));
				expect(added).toHaveLength(1);
				expect(added[0]).toMatchObject({
					lifecycle: "candidate",
					origin: c.adopted,
				});
			} else {
				expect(report.accepted).toBe(0);
				expect(report.reasons).toContain(c.code);
			}
			// An event whose candidates were all refused is still settled (not retried forever).
			expect(mirrorRows(life).at(-1)!.state).toBe("applied");
			expect(assertionRows(life)).toHaveLength(adopted);
		}
	} finally {
		await life.cleanup();
	}
});

test("A19 at most 8 candidates are adopted: the 9th is rejected, never silently dropped", async () => {
	const life = await ready();
	try {
		const rig = rigFor(life, (call) =>
			modelOutput(
				...Array.from({ length: 9 }, (_, i) =>
					candidate(TEXT, utteranceId(call), { predicate: `p${i + 1}` }),
				),
			),
		);
		await drain(rig);
		const report = lastReport(rig);
		expect(report.accepted).toBe(8);
		expect(report.reasons).toContain("CANDIDATE_OVERFLOW");
		expect(assertionRows(life)).toHaveLength(8);
		expect(new Set(assertionRows(life).map((c) => c.id)).size).toBe(8);
	} finally {
		await life.cleanup();
	}
});

test("A19 malformed or oversize output is rejected: no claim, the events are final, the dependents are given back", async () => {
	for (const output of [
		"これはJSONではありません",
		'[{"subject":1}]',
		JSON.stringify({ candidates: [], extra: 1 }),
		JSON.stringify({ candidates: "x".repeat(70 * 1024) }),
	]) {
		const life = await ready();
		try {
			const rig = rigFor(life, () => output);
			await drain(rig);
			expect(lastReport(rig)).toMatchObject({
				disposition: "output_rejected",
				rejected: 1,
			});
			expect(assertionRows(life)).toHaveLength(0);
			expect(mirrorRows(life)[0]).toMatchObject({
				state: "rejected",
				reason: "OUTPUT_REJECTED",
			});
			expect(inboxRows(life).map((r) => r.status)).toEqual(["rejected"]);
			expect(rig.inference.state.rejected).toEqual(["output_rejected"]);
			expect(dependents(life)).toHaveLength(0);
			expect(manifests(life)).toHaveLength(0);
			// Final: it is not extracted again.
			expect(await rig.extraction.schedule(SCOPE)).toMatchObject({
				status: "idle",
			});
		} finally {
			await life.cleanup();
		}
	}
});

test("A20 a window is at most 12 utterances; every input the model saw is in the manifest, cited or not", async () => {
	const texts = Array.from({ length: 13 }, (_, i) => `発言${i + 1}番です。`);
	const life = await ready(texts);
	try {
		const rig = rigFor(life, () => modelOutput());
		const first = await rig.extraction.schedule(SCOPE);
		if (first.status !== "scheduled") throw new Error("not scheduled");
		expect(first.events).toBe(12);
		const run = await runJob(rig, first.jobId);
		if (run.prepared.status !== "ready") throw new Error("not ready");
		expect(run.prepared.input.window).toHaveLength(12);
		expect(run.prepared.input.dependencies).toHaveLength(12);
		// One manifest per event, each listing all 12 sources: nothing is cut to what was quoted.
		const edges = dependents(life);
		const byDependent = new Map<string, number>();
		for (const e of edges)
			byDependent.set(
				e.dependent_id,
				(byDependent.get(e.dependent_id) ?? 0) + 1,
			);
		expect(byDependent.size).toBe(12);
		expect([...byDependent.values()].every((n) => n === 12)).toBe(true);
		expect(
			mirrorRows(life)
				.map((r) => r.state)
				.filter((s) => s === "received"),
		).toHaveLength(1);
		await drain(rig);
		expect(mirrorRows(life).every((r) => r.state === "applied")).toBe(true);
		expect(rig.jobs.size).toBe(2);
	} finally {
		await life.cleanup();
	}
});

test("A20 an utterance that cannot be split is final for extraction, in order, and never reaches the model", async () => {
	const big = "あ".repeat(11_000); // 33000 bytes > 32 KiB
	const life = await ready([big, TEXT, big, "最後の発言です。"]);
	try {
		const rig = rigFor(life, () => modelOutput());
		await drain(rig);
		expect(mirrorRows(life).map((r) => [r.state, r.reason])).toEqual([
			["rejected", "UTTERANCE_TOO_LARGE"],
			["applied", null],
			["rejected", "UTTERANCE_TOO_LARGE"],
			["applied", null],
		]);
		expect(rig.inference.state.prompts.join("")).not.toContain("あああああ");
		// Two windows: the oversize one in the middle ended the first.
		expect(rig.jobs.size).toBe(2);
		// The applied position passes only settled events, in order.
		expect(inboxRows(life).map((r) => r.status)).toEqual([
			"rejected",
			"applied",
			"rejected",
			"applied",
		]);
	} finally {
		await life.cleanup();
	}
});

test("A20 exactly 32 KiB in one utterance is allowed, one byte more is not", async () => {
	const fits = "a".repeat(32 * 1024);
	const life = await ready([fits, `${fits}a`]);
	try {
		const rig = rigFor(life, () => modelOutput());
		await drain(rig);
		expect(mirrorRows(life).map((r) => [r.state, r.reason])).toEqual([
			["applied", null],
			["rejected", "UTTERANCE_TOO_LARGE"],
		]);
	} finally {
		await life.cleanup();
	}
});

test("A43 a model call past the 30 s budget (60 ms here) is cancelled, confirmed ended, then retried once", async () => {
	const life = await ready();
	try {
		let calls = 0;
		let aborted = 0;
		const rig = rigFor(life, (call) => {
			calls += 1;
			if (calls === 1)
				return new Promise<string>((_resolve, reject) =>
					call.signal.addEventListener("abort", () => {
						aborted += 1;
						reject(new Error("aborted"));
					}),
				);
			return modelOutput(candidate(TEXT, utteranceId(call)));
		});
		const scheduled = await rig.extraction.schedule(SCOPE);
		if (scheduled.status !== "scheduled") throw new Error("not scheduled");
		const started = Date.now();
		const first = await runJob(rig, scheduled.jobId, { attempt: 1 });
		expect(Date.now() - started).toBeLessThan(2000);
		expect(first.outcome).toMatchObject({
			type: "retry",
			errorCode: "extract_timeout",
		});
		expect(aborted).toBe(1);
		// The attempt left nothing behind: no claim, the dependents given back, the request withdrawn.
		expect(assertionRows(life)).toHaveLength(0);
		expect(dependents(life)).toHaveLength(0);
		expect(rig.inference.state.cancelled).toContain("req-1");
		expect(mirrorRows(life)[0]).toMatchObject({
			state: "received",
			job_id: scheduled.jobId,
			manifest_id: null,
			failures: 0,
		});
		// The queue runs the same job again.
		const second = await runJob(rig, scheduled.jobId, { attempt: 2 });
		expect(second.outcome?.type).toBe("success");
		expect(assertionRows(life)).toHaveLength(1);
		expect(rig.inference.state.executed).toBe(2);
	} finally {
		await life.cleanup();
	}
});

test("A43 a second timeout fails the job: the input waits out a backoff, then a new job takes it", async () => {
	const life = await ready();
	try {
		let nowMs = 1791500000000;
		const rig = rigFor(
			life,
			(call) =>
				new Promise<string>((_resolve, reject) =>
					call.signal.addEventListener("abort", () => reject(new Error("x"))),
				),
			{ clock: () => nowMs },
		);
		const scheduled = await rig.extraction.schedule(SCOPE);
		if (scheduled.status !== "scheduled") throw new Error("not scheduled");
		await runJob(rig, scheduled.jobId, { attempt: 1 });
		const last = await runJob(rig, scheduled.jobId, { attempt: 2 });
		expect(last.outcome).toMatchObject({
			type: "failed",
			errorCode: "extract_timeout",
		});
		expect(mirrorRows(life)[0]).toMatchObject({
			state: "received",
			job_id: null,
			failures: 1,
		});
		expect(mirrorRows(life)[0]!.retry_at_ms).toBeGreaterThan(nowMs);
		expect(await rig.extraction.schedule(SCOPE)).toMatchObject({
			status: "idle",
			reason: "backoff",
		});
		const calls = rig.inference.state.executed;
		nowMs += 60 * 60_000;
		expect((await rig.extraction.schedule(SCOPE)).status).toBe("scheduled");
		expect(rig.inference.state.executed).toBe(calls);
	} finally {
		await life.cleanup();
	}
});

test("A43 a cancelled call that never ends keeps the Local slot: no second call starts", async () => {
	const life = await ready([TEXT, "別の話題の発言。"]);
	try {
		let release: (text: string) => void = () => {};
		const rig = rigFor(life, (call) => {
			if (call.requestId === "req-1")
				return new Promise<string>((resolve) => {
					release = resolve;
				}); // ignores the abort
			return modelOutput();
		});
		const first = await rig.extraction.schedule(SCOPE);
		if (first.status !== "scheduled") throw new Error("not scheduled");
		const stuck = await runJob(rig, first.jobId);
		expect(stuck.outcome).toMatchObject({
			type: "failed",
			errorCode: "extract_cancel_unconfirmed",
		});
		const afterFailure = rig.inference.state.executed;
		// While the cancel is unconfirmed nothing new is scheduled: the input waits
		// (P4-03 holds it instead of starting a second call on the busy slot).
		const jobs = [...rig.jobs.values()];
		expect(jobs).toHaveLength(1);
		await life.store.write((db) =>
			db.query("UPDATE world_host_extract_event SET retry_at_ms = 0").run(),
		);
		expect(await rig.extraction.schedule(SCOPE)).toMatchObject({
			status: "idle",
			reason: "extract_slot_busy",
		});
		expect(rig.extraction.slotBusy()).toBe(true);
		// The second call never reached the provider.
		expect(rig.inference.state.executed).toBe(afterFailure);
		// The provider finally ends the call: the slot is free again.
		release("{}");
		await Bun.sleep(5);
		await life.store.write((db) =>
			db.query("UPDATE world_host_extract_event SET retry_at_ms = 0").run(),
		);
		const third = await rig.extraction.schedule(SCOPE);
		if (third.status !== "scheduled") throw new Error("not scheduled");
		const free = await runJob(rig, third.jobId);
		expect(free.outcome?.type).toBe("success");
	} finally {
		await life.cleanup();
	}
});

test("A43 an input version that moved after prepare voids the result: nothing is adopted and the new version is extracted", async () => {
	const life = await ready();
	try {
		const rig = rigFor(life, (call) =>
			modelOutput(candidate(TEXT, utteranceId(call))),
		);
		const scheduled = await rig.extraction.schedule(SCOPE);
		if (scheduled.status !== "scheduled") throw new Error("not scheduled");
		const job = rig.jobs.get(scheduled.jobId)!;
		const claim = {
			jobId: scheduled.jobId,
			scope: "world",
			kind: job.kind,
			payloadVersion: 1,
			payload: job.payload as never,
			subjectRef: null,
			owner: "o",
			attempt: 1,
			generation: 0,
			maxAttempts: 2,
			deadlineAtMs: null,
		};
		const handler = rig.extraction.handler;
		const prepared = await life.store.write((db) =>
			handler.prepareInTransaction(db, claim),
		);
		if (prepared.status !== "ready") throw new Error("not ready");
		const result = await handler.execute(prepared.input, {
			signal: new AbortController().signal,
			jobId: claim.jobId,
			attempt: 1,
			generation: 0,
		});
		// The message is corrected while the model was thinking.
		await life.conversation.correct({
			messageId: "m1",
			text: "音声サービスは10月から利用できる。",
		});
		await life.store.write((db) =>
			handler.settleInTransaction(db, claim, prepared.input, {
				type: "success",
				result,
			}),
		);
		job.state = "completed";
		expect(lastReport(rig)).toMatchObject({
			disposition: "not_adopted",
			reasons: ["input_version_changed"],
		});
		expect(assertionRows(life)).toHaveLength(0);
		expect(manifests(life)).toHaveLength(0);
		expect(dependents(life)).toHaveLength(0);
		expect(rig.inference.state.rejected).toEqual(["input_version_changed"]);
		expect(mirrorRows(life)[0]).toMatchObject({
			state: "received",
			job_id: null,
		});
		// The corrected message arrives through the feed; the stale event is final, the new one extracted.
		await life.lifecycle.consumeSourceChanges(SCOPE);
		await drain(rig);
		expect(mirrorRows(life).map((r) => [r.state, r.reason])).toEqual([
			["rejected", "SUPERSEDED"],
			["applied", null],
		]);
		expect(rig.inference.state.prompts.at(-1)).toContain("10月");
	} finally {
		await life.cleanup();
	}
});

test("A43 Memory refusing the dependent registration stops the job before the model is called", async () => {
	const life = await ready();
	try {
		const rig = rigFor(life, () => modelOutput());
		// Memory already forgot the source: it refuses new dependents on it.
		await memoryForgetSource(life, keyOf("m1"));
		const scheduled = await rig.extraction.schedule(SCOPE);
		if (scheduled.status !== "scheduled") throw new Error("not scheduled");
		const run = await runJob(rig, scheduled.jobId);
		expect(run.prepared).toMatchObject({
			status: "stale",
			reason: "memory_memory_tombstoned",
		});
		expect(run.outcome).toBeUndefined();
		expect(rig.inference.state.executed).toBe(0);
		expect(rig.inference.state.captured).toHaveLength(0);
		expect(dependents(life)).toHaveLength(0);
		expect(assertionRows(life)).toHaveLength(0);
		expect(mirrorRows(life)[0]).toMatchObject({
			state: "received",
			job_id: null,
			failures: 1,
		});
	} finally {
		await life.cleanup();
	}
});

test("A43 a provider that is unavailable leaves the input pending; no Cloud request exists", async () => {
	const life = await ready();
	try {
		const rig = rigFor(life, () => {
			throw new Error("larm_control_503");
		});
		const scheduled = await rig.extraction.schedule(SCOPE);
		if (scheduled.status !== "scheduled") throw new Error("not scheduled");
		await runJob(rig, scheduled.jobId, { attempt: 1 });
		const last = await runJob(rig, scheduled.jobId, { attempt: 2 });
		expect(last.outcome).toMatchObject({
			type: "failed",
			errorCode: "larm_control_503",
		});
		expect(assertionRows(life)).toHaveLength(0);
		expect(mirrorRows(life)[0]).toMatchObject({
			state: "received",
			failures: 1,
			job_id: null,
		});
		expect(dependents(life)).toHaveLength(0);
		expect(rig.inference.state.cloudRequests).toBe(0);
	} finally {
		await life.cleanup();
	}
});

test("A43 extraction refuses a route that is not provably Local", async () => {
	for (const snapshotFor of [
		() => ({ routes: { llm: { mode: "larm-preferred", cloudAllowed: true } } }),
		() => ({ routes: { llm: { mode: "larm-only", cloudAllowed: true } } }),
		() => null,
	]) {
		const life = await ready();
		try {
			const rig = rigFor(life, () => modelOutput(), {}, { snapshotFor });
			const scheduled = await rig.extraction.schedule(SCOPE);
			if (scheduled.status !== "scheduled") throw new Error("not scheduled");
			const run = await runJob(rig, scheduled.jobId);
			expect(run.prepared).toMatchObject({
				status: "stale",
				reason: "local_provider_required",
			});
			expect(rig.inference.state.executed).toBe(0);
			expect(rig.inference.state.cancelled).toEqual(["req-1"]);
			expect(dependents(life)).toHaveLength(0);
		} finally {
			await life.cleanup();
		}
	}
});

test("extraction runs only while World is ON and its gate is open; one job per Scope at a time", async () => {
	const life = await ready();
	try {
		const rig = rigFor(life, () => modelOutput());
		const first = await rig.extraction.schedule(SCOPE);
		expect(first.status).toBe("scheduled");
		// A second request while the first job is open creates nothing.
		expect(await rig.extraction.schedule(SCOPE)).toMatchObject({
			status: "idle",
			reason: "job_open",
		});
		expect(rig.jobs.size).toBe(1);
		await life.world.setEnabled(false);
		if (first.status !== "scheduled") throw new Error("not scheduled");
		const run = await runJob(rig, first.jobId);
		expect(run.prepared).toMatchObject({
			status: "stale",
			reason: "world_disabled",
		});
		expect(rig.inference.state.executed).toBe(0);
		expect(await rig.extraction.schedule(SCOPE)).toMatchObject({
			status: "idle",
			reason: "world_disabled",
		});
		await life.world.setEnabled(true);
		life.gate.close("TEST");
		expect(await rig.extraction.schedule(SCOPE)).toMatchObject({
			status: "idle",
			reason: "world_gate_closed",
		});
		life.gate.open();
		// The input survived all of it.
		expect(mirrorRows(life)[0]!.state).toBe("received");
		expect((await rig.extraction.schedule(SCOPE)).status).toBe("scheduled");
	} finally {
		await life.cleanup();
	}
});

test("cancelling a prepared job gives back its Memory dependents and its model request", async () => {
	const life = await ready();
	try {
		const rig = rigFor(life, () => modelOutput());
		const scheduled = await rig.extraction.schedule(SCOPE);
		if (scheduled.status !== "scheduled") throw new Error("not scheduled");
		const job = rig.jobs.get(scheduled.jobId)!;
		const claim = {
			jobId: scheduled.jobId,
			scope: "world",
			kind: job.kind,
			payloadVersion: 1,
			payload: job.payload as never,
			subjectRef: null,
			owner: "o",
			attempt: 1,
			generation: 0,
			maxAttempts: 2,
			deadlineAtMs: null,
		};
		const handler = rig.extraction.handler;
		const prepared = await life.store.write((db) =>
			handler.prepareInTransaction(db, claim),
		);
		expect(prepared.status).toBe("ready");
		expect(dependents(life).length).toBeGreaterThan(0);
		await life.store.write((db) =>
			handler.cancelInTransaction(
				db,
				{
					jobId: claim.jobId,
					subjectRef: null,
					payload: job.payload as never,
				},
				"cancelled",
			),
		);
		expect(dependents(life)).toHaveLength(0);
		expect(rig.inference.state.cancelled).toEqual(["req-1"]);
		expect(mirrorRows(life)[0]).toMatchObject({
			state: "received",
			job_id: null,
			manifest_id: null,
			failures: 0,
		});
	} finally {
		await life.cleanup();
	}
});
