import { expect, test } from "bun:test";
import { SCOPE, addMessage, entityOp, worldEdges } from "./fixture";
import { openLife, reopenLife } from "./lifecycle-fixture";
import {
	SERVICE_ENTITY,
	assertionRows,
	candidate,
	checkpointRows,
	drain,
	inboxRows,
	mirrorRows,
	modelOutput,
	rigFor,
	runJob,
	type Call,
	type Rig,
} from "./extraction-fixture";

const TEXT = "音声サービスは利用できます。";
const idOf = (call: Call) =>
	JSON.parse(call.messages[1]!.content).utterances[0].utteranceId as string;
const aliasOutput = (call: Call) =>
	modelOutput(
		candidate(TEXT, idOf(call), {
			subject: { kind: "alias", text: SERVICE_ENTITY.displayName },
		}),
	);
const dependents = (life: Rig["life"]) =>
	worldEdges(life).filter((e) => e.dependent_id.includes(":w1m-"));

async function ready() {
	const life = await openLife();
	await life.lifecycle.recoverWorld();
	await life.world.apply(entityOp());
	await addMessage(life, "m1", TEXT);
	await life.lifecycle.consumeSourceChanges(SCOPE);
	return life;
}

test("held extraction remains received across polls and restart, then applies once with new entities", async () => {
	let life = await ready();
	let entities: unknown[] = [];
	try {
		const rig = rigFor(life, aliasOutput, { entities: () => entities });
		expect(await drain(rig)).toHaveLength(1);
		expect(rig.reports.at(-1)).toMatchObject({
			disposition: "not_adopted",
			accepted: 0,
			held: 1,
			reasons: ["EXTRACTION_CONTEXT_HELD"],
		});
		expect(mirrorRows(life)[0]).toMatchObject({
			state: "received",
			failures: 0,
			job_id: null,
			manifest_id: null,
			request_id: null,
		});
		expect(inboxRows(life)[0]!.status).toBe("received");
		expect(assertionRows(life)).toHaveLength(0);
		expect(checkpointRows(life)[0]!.applied_cursor).toBeNull();
		expect(dependents(life)).toHaveLength(0);
		expect(rig.inference.state.cancelled).toEqual(["req-1"]);
		expect(rig.inference.state.accepted).toBe(0);
		expect(mirrorRows(life)[0]!.held_context_digest).toHaveLength(64);
		expect(mirrorRows(life)[0]!.settled_at_ms).toBeNull();
		expect(await rig.extraction.schedule(SCOPE)).toEqual({
			status: "idle",
			reason: "extraction_context_held",
		});
		expect(rig.inference.state.executed).toBe(1);
		life = await reopenLife(life);
		await life.lifecycle.recoverWorld();
		const restarted = rigFor(life, aliasOutput, { entities: () => entities });
		expect(await drain(restarted)).toHaveLength(0);
		entities = [SERVICE_ENTITY];
		expect(await drain(restarted)).toHaveLength(1);
		expect(assertionRows(life)).toHaveLength(1);
		expect(inboxRows(life)[0]!.status).toBe("applied");
		expect(mirrorRows(life)[0]!.held_context_digest).toBeNull();
		expect(checkpointRows(life)[0]!.applied_cursor).not.toBeNull();
		expect(await drain(restarted)).toHaveLength(0);
	} finally {
		await life.cleanup();
	}
});

test("one held candidate holds the whole prefix; later input does not bypass it", async () => {
	const life = await ready();
	let entities = [SERVICE_ENTITY];
	try {
		await addMessage(life, "m2", TEXT);
		await life.lifecycle.consumeSourceChanges(SCOPE);
		const rig = rigFor(
			life,
			(call) => {
				const utterances = JSON.parse(call.messages[1]!.content).utterances as {
					utteranceId: string;
				}[];
				return modelOutput(
					...utterances.map((u, i) =>
						candidate(TEXT, u.utteranceId, {
							predicate: `property-${i}`,
							payload: {
								kind: "value",
								value: { kind: "boolean", value: false },
							},
							...(i === 1
								? { subject: { kind: "alias", text: "別の呼び名" } }
								: {}),
						}),
					),
				);
			},
			{ entities: () => entities },
		);
		expect(await drain(rig)).toHaveLength(1);
		expect(mirrorRows(life).map((r) => r.state)).toEqual([
			"received",
			"received",
		]);
		expect(inboxRows(life).map((r) => r.status)).toEqual([
			"received",
			"received",
		]);
		expect(assertionRows(life)).toHaveLength(0);
		await addMessage(life, "m3", TEXT);
		await life.lifecycle.consumeSourceChanges(SCOPE);
		expect(await drain(rig)).toHaveLength(0);
		expect(checkpointRows(life)[0]!.applied_cursor).toBeNull();
		entities = [
			{ ...SERVICE_ENTITY, aliases: [...SERVICE_ENTITY.aliases, "別の呼び名"] },
		];
		expect(await drain(rig)).toHaveLength(1);
		expect(assertionRows(life)).toHaveLength(3);
		expect(mirrorRows(life).map((r) => r.state)).toEqual([
			"applied",
			"applied",
			"applied",
		]);
		expect(await drain(rig)).toHaveLength(0);
	} finally {
		await life.cleanup();
	}
});

test("a port mutated during inference cannot change the prepared entities or authorize the old result", async () => {
	const life = await ready();
	const entity = { ...SERVICE_ENTITY, aliases: [...SERVICE_ENTITY.aliases] };
	let changed = false;
	try {
		const rig = rigFor(
			life,
			(call) => {
				if (!changed) {
					entity.aliases.push("追加名");
					changed = true;
				}
				return modelOutput(candidate(TEXT, idOf(call)));
			},
			{ entities: () => [entity] },
		);
		const scheduled = await rig.extraction.schedule(SCOPE);
		if (scheduled.status !== "scheduled") throw new Error("not scheduled");
		const run = await runJob(rig, scheduled.jobId);
		if (run.prepared.status !== "ready") throw new Error("not ready");
		expect(run.prepared.input.entities).toEqual([SERVICE_ENTITY]);
		expect(rig.reports.at(-1)).toMatchObject({
			disposition: "not_adopted",
			reasons: ["extraction_context_changed"],
		});
		expect(assertionRows(life)).toHaveLength(0);
		expect(dependents(life)).toHaveLength(0);
		expect(mirrorRows(life)[0]!.held_context_digest).toBeNull();
		expect(await drain(rig)).toHaveLength(1);
		expect(assertionRows(life)).toHaveLength(1);
	} finally {
		await life.cleanup();
	}
});

test("prepare rechecks a queued retry when its context reverts to the held snapshot", async () => {
	const life = await ready();
	let entities: unknown[] = [];
	try {
		const rig = rigFor(life, aliasOutput, { entities: () => entities });
		await drain(rig);
		entities = [SERVICE_ENTITY];
		const scheduled = await rig.extraction.schedule(SCOPE);
		if (scheduled.status !== "scheduled") throw new Error("not scheduled");
		entities = [];
		expect((await runJob(rig, scheduled.jobId)).prepared).toEqual({
			status: "stale",
			reason: "extraction_context_held",
		});
		expect(rig.inference.state.executed).toBe(1);
		expect(rig.inference.state.captured).toHaveLength(1);
		expect(mirrorRows(life)[0]!.job_id).toBeNull();
		expect(await drain(rig)).toHaveLength(0);
	} finally {
		await life.cleanup();
	}
});

test("a corrected or unavailable held head reaches final rejection before context suppression", async () => {
	for (const corrected of [true, false]) {
		const life = await ready();
		try {
			const rig = rigFor(life, aliasOutput, { entities: () => [] });
			await drain(rig);
			if (corrected)
				await life.conversation.correct({
					messageId: "m1",
					text: "訂正しました。",
				});
			else await life.conversation.retract({ messageId: "m1" });
			// Do not consume the feed: schedule must recheck source liveness itself.
			expect(await drain(rig)).toHaveLength(1);
			expect(rig.inference.state.executed).toBe(1);
			expect(mirrorRows(life)[0]).toMatchObject({
				state: "rejected",
				held_context_digest: null,
				reason: corrected ? "SUPERSEDED" : "SOURCE_GONE",
			});
			expect(inboxRows(life)[0]!.status).toBe("rejected");
		} finally {
			await life.cleanup();
		}
	}
});

test("forget removes held inputs and the digest without leaving a cursor-blocking row", async () => {
	const life = await ready();
	try {
		const rig = rigFor(life, aliasOutput, { entities: () => [] });
		await drain(rig);
		await life.conversation.retract({ messageId: "m1" });
		await life.lifecycle.consumeSourceChanges(SCOPE);
		expect(mirrorRows(life)).toHaveLength(0);
		expect(inboxRows(life)).toHaveLength(0);
		expect(await drain(rig)).toHaveLength(0);
	} finally {
		await life.cleanup();
	}
});

test("a refused manifest release stays pending while the extraction is held", async () => {
	const life = await ready();
	try {
		const rig = rigFor(life, aliasOutput, {
			entities: () => [],
			memory: { unregister: () => "blocked" },
		});
		await drain(rig);
		expect(mirrorRows(life)[0]!.state).toBe("received");
		const rows = life.store.read((db) =>
			db.query("SELECT release_pending FROM world_host_dependent").all(),
		);
		expect(rows.length).toBeGreaterThan(0);
		expect(rows).toEqual(rows.map(() => ({ release_pending: 1 })));
		expect(await drain(rig)).toHaveLength(0);
		await life.lifecycle.sweepPendingReleases();
		expect(dependents(life)).toHaveLength(0);
		expect(mirrorRows(life)[0]!.held_context_digest).toHaveLength(64);
	} finally {
		await life.cleanup();
	}
});

test("a failed held transaction rolls back its digest and remains recoverable", async () => {
	const life = await ready();
	let fail = true;
	try {
		const rig = rigFor(life, aliasOutput, {
			entities: () => [],
			onReport: () => {
				if (fail) throw new Error("writer_probe");
			},
		});
		await expect(drain(rig)).rejects.toThrow("writer_probe");
		expect(mirrorRows(life)[0]).toMatchObject({
			state: "received",
			reason: null,
			held_context_digest: null,
		});
		expect(inboxRows(life)[0]!.status).toBe("received");
		expect(assertionRows(life)).toHaveLength(0);
		fail = false;
		const job = [...rig.jobs.values()][0]!;
		expect((await runJob(rig, job.id, { attempt: 2 })).settle).toBe("applied");
		expect(mirrorRows(life)[0]!.held_context_digest).toHaveLength(64);
		expect(await drain(rig)).toHaveLength(0);
	} finally {
		await life.cleanup();
	}
});

test("an interpretation version change releases a held prefix without language-specific code", async () => {
	const life = await ready();
	try {
		const rig = rigFor(life, aliasOutput, { entities: () => [] });
		await drain(rig);
		const next = rigFor(life, () => modelOutput(), {
			entities: () => [],
			interpretationVersion: "extract-next",
		});
		expect(await drain(next)).toHaveLength(1);
		expect(assertionRows(life)).toHaveLength(0);
		expect(mirrorRows(life)[0]).toMatchObject({
			state: "applied",
			held_context_digest: null,
		});
	} finally {
		await life.cleanup();
	}
});

test("a cancelled old result cannot hold or release the newer job's input", async () => {
	const life = await ready();
	let entities: unknown[] = [];
	try {
		const rig = rigFor(life, aliasOutput, { entities: () => entities });
		const prepare = async () => {
			const scheduled = await rig.extraction.schedule(SCOPE);
			if (scheduled.status !== "scheduled") throw new Error("not scheduled");
			const job = rig.jobs.get(scheduled.jobId)!;
			job.state = "running";
			const claim = {
				jobId: job.id,
				scope: "world",
				kind: job.kind,
				payloadVersion: 1,
				payload: job.payload as never,
				subjectRef: null,
				owner: "fixture",
				attempt: 1,
				generation: 0,
				maxAttempts: 2,
				deadlineAtMs: null,
			};
			const prepared = await life.store.write((db) =>
				rig.extraction.handler.prepareInTransaction(db, claim),
			);
			if (prepared.status !== "ready") throw new Error("not ready");
			return { job, claim, input: prepared.input };
		};
		const old = await prepare();
		const oldResult = await rig.extraction.handler.execute(old.input, {
			signal: new AbortController().signal,
			jobId: old.job.id,
			attempt: 1,
			generation: 0,
		});
		await life.store.write((db) =>
			rig.extraction.handler.cancelInTransaction(
				db,
				{ jobId: old.job.id, payload: old.claim.payload, subjectRef: null },
				"cancelled",
			),
		);
		old.job.state = "cancelled";
		entities = [SERVICE_ENTITY];
		const next = await prepare();
		const before = mirrorRows(life);
		await life.store.write((db) =>
			rig.extraction.handler.settleInTransaction(db, old.claim, old.input, {
				type: "success",
				result: oldResult,
			}),
		);
		expect(mirrorRows(life)).toEqual(before);
		expect(rig.inference.state.cancelled).not.toContain(next.input.requestId);
		const result = await rig.extraction.handler.execute(next.input, {
			signal: new AbortController().signal,
			jobId: next.job.id,
			attempt: 1,
			generation: 0,
		});
		await life.store.write((db) =>
			rig.extraction.handler.settleInTransaction(db, next.claim, next.input, {
				type: "success",
				result,
			}),
		);
		expect(assertionRows(life)).toHaveLength(1);
		expect(mirrorRows(life)[0]).toMatchObject({
			state: "applied",
			held_context_digest: null,
		});
	} finally {
		await life.cleanup();
	}
});

test("restore purges held metadata and redelivers only the unsettled input", async () => {
	const life = await ready();
	try {
		const rig = rigFor(life, aliasOutput, { entities: () => [] });
		await drain(rig);
		const eventId = mirrorRows(life)[0]!.event_id;
		expect((await life.lifecycle.startRestore()).status).toBe("open");
		expect(mirrorRows(life)).toHaveLength(0);
		expect(inboxRows(life)).toHaveLength(0);
		await life.lifecycle.consumeSourceChanges(SCOPE);
		expect(mirrorRows(life)[0]).toMatchObject({
			event_id: eventId,
			state: "received",
			held_context_digest: null,
		});
		expect(await drain(rig)).toHaveLength(1);
		expect(rig.inference.state.executed).toBe(2);
		expect(mirrorRows(life)[0]!.held_context_digest).toHaveLength(64);
	} finally {
		await life.cleanup();
	}
});

test("a refused inference authority check cannot persist a semantic hold", async () => {
	const life = await ready();
	try {
		const rig = rigFor(
			life,
			aliasOutput,
			{ entities: () => [] },
			{ validateReceiptInTransaction: () => false },
		);
		expect(await drain(rig)).toHaveLength(1);
		expect(mirrorRows(life)[0]).toMatchObject({
			state: "received",
			held_context_digest: null,
			failures: 1,
		});
		expect(rig.inference.state.accepted).toBe(0);
		expect(rig.reports.at(-1)).toMatchObject({
			disposition: "not_adopted",
			reasons: ["inference_not_accepted"],
		});
	} finally {
		await life.cleanup();
	}
});
