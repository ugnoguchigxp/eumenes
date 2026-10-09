import { expect, test } from "bun:test";
import type { ListChangesRequest, SourceAdapter, SourceChange } from "..";
import { extractEventId } from "..";
import {
	ACCESS,
	NOW,
	SCOPE,
	addMessage,
	claim,
	currentRef,
	entityOp,
	registerClaim,
} from "./fixture";
import {
	assertionRows,
	candidate,
	checkpointRows,
	drain,
	inboxRows,
	mirrorRows,
	modelOutput,
	rigFor,
	runJob,
} from "./extraction-fixture";
import {
	Crash,
	crashHook,
	openLife,
	reopenLife,
	type Life,
} from "./lifecycle-fixture";

// P4-01: continuous input receipt and progress. A28 (gaps, duplicates, receipt
// vs. application), A29 (forget/correction before pending extraction),
// A42 (resume, empty feed, Scope addition).

const empty = () => modelOutput();
const stages = (life: Life) => life.lifecycle.feedStages(SCOPE);
const OTHER = { principal: SCOPE.principal, scopeKey: "profile:other" };

async function started(over: Parameters<typeof openLife>[0] = {}) {
	const life = await openLife(over);
	expect((await life.lifecycle.recoverWorld()).status).toBe("open");
	return life;
}

test("A28 the inbox row, the host record and the cursor move together; unsettled input is not applied", async () => {
	const life = await started();
	try {
		await addMessage(life, "m1", "音声サービスは9月から利用できる。");
		await addMessage(life, "m2", "別の話題の発言。");
		await addMessage(life, "a1", "承知しました。", "assistant");
		expect(stages(life).source.owner.ahead).toBe(true);
		const report = await life.lifecycle.consumeSourceChanges(SCOPE);
		expect(report).toMatchObject({ blocked: null, changes: 3, received: 2 });
		// World took the two user inputs (the assistant's reply is no input).
		expect(inboxRows(life).map((r) => r.status)).toEqual([
			"received",
			"received",
		]);
		const mirror = mirrorRows(life);
		expect(mirror.map((r) => r.state)).toEqual(["received", "received"]);
		const world = checkpointRows(life);
		expect(world).toHaveLength(1);
		expect(world[0]!.applied_cursor).toBeNull();
		const source = stages(life).source;
		expect(source.owner.ahead).toBe(false);
		expect(source.scanned.cursor).not.toBeNull();
		// The host's received stage is World's received checkpoint.
		expect(source.received).toEqual({
			count: 2,
			lastCursor: world[0]!.received_cursor,
		});
		expect(source.applied).toEqual({
			cursor: null,
			applied: 0,
			rejected: 0,
			pending: 2,
		});
	} finally {
		await life.cleanup();
	}
});

const change = (
	cursor: string,
	id: string,
	at: string,
	kind: SourceChange["kind"] = "added",
): SourceChange => ({
	cursor,
	kind,
	source: {
		namespace: "conversation",
		kind: "message",
		id,
		representation: "text",
	},
	revision: `r-${id}`,
	digest: `sha256:${id}`,
	principal: SCOPE.principal,
	scopeKey: SCOPE.scopeKey,
	speaker: "user",
	occurredAt: at,
});

/** Serves pages in order: the page whose `after` equals the request cursor. */
function scripted(
	pages: { after: string | null; changes: SourceChange[]; next: string }[],
): SourceAdapter {
	return {
		namespace: "conversation",
		resolveCurrent: () => {
			throw new Error("unused");
		},
		readAuthorizedContent: () => {
			throw new Error("unused");
		},
		listChanges: (_db, _access, request: ListChangesRequest) => {
			const page = pages.find((p) => p.after === request.cursor);
			return page
				? {
						changes: page.changes,
						nextCursor: page.next,
						hasMore: pages.some((p) => p.after === page.next),
					}
				: {
						changes: [],
						nextCursor: request.cursor ?? "c-0",
						hasMore: false,
					};
		},
	};
}

test("A28 sequence gaps are accepted and a re-delivered event is received once", async () => {
	const t = "2026-10-09T00:00:00.000Z";
	const life = await started({
		sources: [
			scripted([
				{
					after: null,
					changes: [change("c-100", "m100", t)],
					next: "c-100",
				},
				{
					// 100 -> 105: the positions in between belong to other principals.
					after: "c-100",
					changes: [
						change("c-105", "m105", t),
						change("c-105", "m105", t),
						change("c-100", "m100", t),
					],
					next: "c-105",
				},
			]),
		],
	});
	try {
		const first = await life.lifecycle.consumeSourceChanges(SCOPE);
		expect(first.received).toBe(1);
		const second = await life.lifecycle.consumeSourceChanges(SCOPE);
		expect(second).toMatchObject({ blocked: null, received: 1 });
		expect(inboxRows(life)).toHaveLength(2);
		const mirror = mirrorRows(life);
		expect(mirror.map((r) => r.received_cursor)).toEqual(["c-100", "c-105"]);
		// The applied position never moves just because input arrived.
		expect(checkpointRows(life)[0]!.applied_cursor).toBeNull();
		// A third pass over nothing changes nothing.
		const before = { inbox: inboxRows(life), mirror: mirrorRows(life) };
		await life.lifecycle.consumeSourceChanges(SCOPE);
		expect({ inbox: inboxRows(life), mirror: mirrorRows(life) }).toEqual(
			before,
		);
	} finally {
		await life.cleanup();
	}
});

test("A28 a failed receipt does not move the cursor: the input is received on the next pass", async () => {
	const life = await started({ hook: crashHook("feed_cursor_saved") });
	let next: Life | undefined;
	try {
		await addMessage(life, "m1", "音声サービスは9月から利用できる。");
		await expect(life.lifecycle.consumeSourceChanges(SCOPE)).rejects.toThrow(
			Crash,
		);
		// Nothing of that pass remains: no cursor, no inbox row, no host record.
		expect(
			life.store.read((db) => life.world.feedCursor(db, "source", SCOPE))
				.cursor,
		).toBeNull();
		expect(inboxRows(life)).toHaveLength(0);
		expect(mirrorRows(life)).toHaveLength(0);
		expect(checkpointRows(life)).toHaveLength(0);
		next = await reopenLife(life);
		expect((await next.lifecycle.recoverWorld()).status).toBe("open");
		const report = await next.lifecycle.consumeSourceChanges(SCOPE);
		expect(report.received).toBe(1);
		expect(inboxRows(next)).toHaveLength(1);
	} finally {
		await (next ?? life).cleanup();
	}
});

test("A42 a crash right after receipt: the unapplied inbox is resumed, nothing is received twice", async () => {
	const life = await started();
	let next: Life | undefined;
	try {
		await addMessage(life, "m1", "音声サービスは9月から利用できる。");
		await addMessage(life, "m2", "別の話題の発言。");
		await life.lifecycle.consumeSourceChanges(SCOPE);
		const received = mirrorRows(life);
		// A new process: same database, no memory of the previous one.
		next = await reopenLife(life);
		expect((await next.lifecycle.recoverWorld()).status).toBe("open");
		expect(stages(next).source.applied).toMatchObject({
			cursor: null,
			pending: 2,
		});
		const again = await next.lifecycle.consumeSourceChanges(SCOPE);
		expect(again).toMatchObject({ changes: 0, received: 0 });
		expect(mirrorRows(next)).toEqual(received);
		expect(inboxRows(next)).toHaveLength(2);
		// Resumed: the semantic application runs now, and only now.
		const rig = rigFor(next, empty);
		const ran = await drain(rig);
		expect(ran).toHaveLength(1);
		const done = stages(next).source;
		expect(done.applied).toMatchObject({ applied: 2, pending: 0 });
		expect(done.applied.cursor).toBe(received[1]!.received_cursor);
		expect(checkpointRows(next)[0]).toMatchObject({
			received_cursor: received[1]!.received_cursor,
			applied_cursor: received[1]!.received_cursor,
		});
		expect(inboxRows(next).map((r) => r.status)).toEqual([
			"applied",
			"applied",
		]);
	} finally {
		await (next ?? life).cleanup();
	}
});

test("A42 a crash while applying leaves nothing half applied; the next job applies once", async () => {
	const text = "音声サービスは9月から利用できる。";
	const life = await started();
	try {
		expect((await life.world.apply(entityOp())).status).toBe("applied");
		await addMessage(life, "m1", text);
		await addMessage(life, "m2", "別の話題の発言。");
		await life.lifecycle.consumeSourceChanges(SCOPE);
		const ids = mirrorRows(life).map((r) => r.event_id);
		let crash = true;
		const rig = rigFor(life, () => modelOutput(candidate(text, ids[0]!)), {
			hook: (point) => {
				// Dies after the FIRST event was settled inside the transaction.
				if (point === "event_settled" && crash) {
					crash = false;
					throw new Crash("feed_cursor_saved");
				}
			},
		});
		const scheduled = await rig.extraction.schedule(SCOPE);
		if (scheduled.status !== "scheduled") throw new Error("not scheduled");
		await expect(runJob(rig, scheduled.jobId)).rejects.toThrow(Crash);
		rig.jobs.get(scheduled.jobId)!.state = "failed";
		// The whole settle rolled back: both events are still unsettled, no claim exists.
		expect(mirrorRows(life).map((r) => r.state)).toEqual([
			"received",
			"received",
		]);
		expect(inboxRows(life).map((r) => r.status)).toEqual([
			"received",
			"received",
		]);
		expect(checkpointRows(life)[0]!.applied_cursor).toBeNull();
		expect(assertionRows(life)).toHaveLength(0);
		expect(stages(life).source.applied.cursor).toBeNull();
		// The crashed attempt is over: a new job takes the same input.
		const ran = await drain(rig);
		expect(ran).toHaveLength(1);
		expect(mirrorRows(life).map((r) => r.state)).toEqual([
			"applied",
			"applied",
		]);
		expect(assertionRows(life)).toHaveLength(1);
		expect(assertionRows(life)[0]).toMatchObject({
			lifecycle: "candidate",
			origin: "user_report",
		});
		expect(rig.inference.state.cloudRequests).toBe(0);
	} finally {
		await life.cleanup();
	}
});

test("A28 the applied position is the settled PREFIX: 13 inputs, 12 settled, one pending", async () => {
	const life = await started();
	try {
		for (let i = 1; i <= 13; i++)
			await addMessage(life, `m${i}`, `発言${i}番です。`);
		await life.lifecycle.consumeSourceChanges(SCOPE);
		const rig = rigFor(life, empty);
		const first = await rig.extraction.schedule(SCOPE);
		if (first.status !== "scheduled") throw new Error("not scheduled");
		await runJob(rig, first.jobId);
		const mirror = mirrorRows(life);
		expect(mirror.filter((r) => r.state === "applied")).toHaveLength(12);
		const source = stages(life).source;
		expect(source.applied).toMatchObject({ applied: 12, pending: 1 });
		// Never past the oldest unsettled event: it is the 12th event's cursor, not the 13th's.
		expect(source.applied.cursor).toBe(mirror[11]!.received_cursor);
		expect(source.received.lastCursor).toBe(mirror[12]!.received_cursor);
		expect(checkpointRows(life)[0]).toMatchObject({
			applied_cursor: mirror[11]!.received_cursor,
			received_cursor: mirror[12]!.received_cursor,
		});
		await drain(rig);
		expect(stages(life).source.applied).toMatchObject({
			applied: 13,
			pending: 0,
		});
	} finally {
		await life.cleanup();
	}
});

test("A29 a forget overtakes the pending extraction: nothing of the forgotten message is read or kept", async () => {
	const life = await started();
	try {
		await addMessage(life, "m1", "秘密の発言: 暗証番号は1234。");
		await addMessage(life, "m2", "音声サービスは9月から利用できる。");
		await life.lifecycle.consumeSourceChanges(SCOPE);
		expect(inboxRows(life)).toHaveLength(2);
		await life.conversation.retract({ messageId: "m1" });
		const report = await life.lifecycle.consumeSourceChanges(SCOPE);
		expect(report.forgets.map((f) => f.state)).toEqual(["complete"]);
		// Gone from World's inbox AND from the host record, before any extraction ran.
		expect(inboxRows(life)).toHaveLength(1);
		expect(mirrorRows(life)).toHaveLength(1);
		const rig = rigFor(life, empty);
		const ran = await drain(rig);
		expect(ran).toHaveLength(1);
		const prompts = rig.inference.state.prompts.join("\n");
		expect(rig.inference.state.prompts).toHaveLength(1);
		expect(prompts).toContain("音声サービス");
		expect(prompts).not.toContain("1234");
		expect(mirrorRows(life).map((r) => r.state)).toEqual(["applied"]);
	} finally {
		await life.cleanup();
	}
});

test("A29 a correction stops the old claim before the pending extraction, which then reads only the new text", async () => {
	const life = await started();
	try {
		await addMessage(life, "m1", "音声サービスは9月から利用できる。");
		expect((await life.world.apply(entityOp())).status).toBe("applied");
		expect(
			(
				await life.world.apply(
					registerClaim("c-1", claim("claim-1", [currentRef(life, "m1")])),
				)
			).status,
		).toBe("applied");
		await life.lifecycle.consumeSourceChanges(SCOPE);
		expect(mirrorRows(life)).toHaveLength(1);
		await life.conversation.correct({
			messageId: "m1",
			text: "音声サービスは10月から利用できる。",
		});
		const report = await life.lifecycle.consumeSourceChanges(SCOPE);
		// Stopped in the same pass that received the corrected input.
		expect(report.invalidated).toBeGreaterThan(0);
		const lifecycle = life.store.read((db) =>
			db
				.query(
					"SELECT lifecycle FROM world_assertion WHERE id = 'claim-1' ORDER BY revision DESC LIMIT 1",
				)
				.get(),
		) as { lifecycle: string };
		expect(lifecycle.lifecycle).toBe("invalidated");
		expect(mirrorRows(life)).toHaveLength(2);
		const rig = rigFor(life, empty);
		await drain(rig);
		const states = mirrorRows(life).map((r) => [r.state, r.reason]);
		expect(states).toEqual([
			["rejected", "SUPERSEDED"],
			["applied", null],
		]);
		// One model call, and it saw only the corrected text.
		expect(rig.inference.state.prompts).toHaveLength(1);
		expect(rig.inference.state.prompts[0]).toContain("10月");
		expect(rig.inference.state.prompts[0]).not.toContain("9月");
	} finally {
		await life.cleanup();
	}
});

test("A29 forgetting does not wait for World or the model: it proceeds while World is OFF", async () => {
	const life = await started();
	try {
		await addMessage(life, "m1", "秘密の発言: 暗証番号は1234。");
		await life.lifecycle.consumeSourceChanges(SCOPE);
		expect(inboxRows(life)).toHaveLength(1);
		await life.world.setEnabled(false);
		// The model is absent too: any call would fail.
		const rig = rigFor(life, () => {
			throw new Error("model_absent");
		});
		await life.conversation.retract({ messageId: "m1" });
		const report = await life.lifecycle.consumeSourceChanges(SCOPE);
		expect(report.forgets.map((f) => f.state)).toEqual(["complete"]);
		expect(inboxRows(life)).toHaveLength(0);
		expect(mirrorRows(life)).toHaveLength(0);
		expect(rig.inference.state.executed).toBe(0);
	} finally {
		await life.cleanup();
	}
});

test("A42 adding a Scope discards the cursor and reads the feed again; unsettled input still settles", async () => {
	const life = await started({ scopes: [SCOPE] });
	let next: Life | undefined;
	try {
		await addMessage(life, "m1", "音声サービスは9月から利用できる。");
		await addMessage(life, "m2", "別の話題の発言。");
		await life.lifecycle.consumeSourceChanges(SCOPE);
		const before = mirrorRows(life);
		next = await reopenLife(life, { scopes: [SCOPE, OTHER] });
		expect((await next.lifecycle.recoverWorld()).status).toBe("open");
		const report = await next.lifecycle.consumeSourceChanges(SCOPE);
		expect(report).toMatchObject({ resync: true, blocked: null, received: 0 });
		// Re-read, not re-received: same events, same inbox rows.
		expect(mirrorRows(next)).toEqual(before);
		expect(inboxRows(next)).toHaveLength(2);
		// New input arrives under the NEW Scope set.
		await addMessage(next, "m3", "三つ目の発言です。");
		await next.lifecycle.consumeSourceChanges(SCOPE);
		expect(new Set(inboxRows(next).map((r) => r.feed_key)).size).toBe(2);
		expect(checkpointRows(next)).toHaveLength(2);
		// Every event settles under the feed it was delivered under.
		const rig = rigFor(next, empty);
		await drain(rig);
		expect(mirrorRows(next).map((r) => r.state)).toEqual([
			"applied",
			"applied",
			"applied",
		]);
		expect(inboxRows(next).map((r) => r.status)).toEqual([
			"applied",
			"applied",
			"applied",
		]);
		// A second pass over the same Scope set is not a resync.
		const quiet = await next.lifecycle.consumeSourceChanges(SCOPE);
		expect(quiet.resync).toBe(false);
	} finally {
		await (next ?? life).cleanup();
	}
});

test("A42 a restore epoch change drops the cursors; unsettled input is delivered again, settled input is not", async () => {
	const life = await started();
	try {
		await addMessage(life, "m1", "音声サービスは9月から利用できる。");
		await life.lifecycle.consumeSourceChanges(SCOPE);
		const rig = rigFor(life, empty);
		await drain(rig);
		await addMessage(life, "m2", "別の話題の発言。");
		await life.lifecycle.consumeSourceChanges(SCOPE);
		const [settled, open] = mirrorRows(life);
		expect([settled!.state, open!.state]).toEqual(["applied", "received"]);
		const epoch = life.store.read((db) => life.world.restoreEpoch(db));
		expect((await life.lifecycle.startRestore()).status).toBe("open");
		expect(life.store.read((db) => life.world.restoreEpoch(db))).not.toBe(
			epoch,
		);
		// The unsettled record went with World's deleted inbox row; the settled one stays.
		expect(mirrorRows(life).map((r) => r.state)).toEqual(["applied"]);
		expect(inboxRows(life).map((r) => r.status)).toEqual(["applied"]);
		const again = await life.lifecycle.consumeSourceChanges(SCOPE);
		expect(again).toMatchObject({ blocked: null, received: 1 });
		expect(mirrorRows(life).map((r) => r.state)).toEqual([
			"applied",
			"received",
		]);
		expect(mirrorRows(life)[1]!.event_id).toBe(open!.event_id);
		await drain(rig);
		expect(mirrorRows(life).map((r) => r.state)).toEqual([
			"applied",
			"applied",
		]);
	} finally {
		await life.cleanup();
	}
});

test("A42 an empty feed creates no job and no model request", async () => {
	const life = await started();
	try {
		const rig = rigFor(life, empty);
		let commits = 0;
		const stop = life.store.onCommit(() => {
			commits += 1;
		});
		// Nothing at all.
		await life.lifecycle.consumeSourceChanges(SCOPE);
		const baseline = commits;
		for (let i = 0; i < 3; i++) {
			expect(await life.lifecycle.consumeSourceChanges(SCOPE)).toMatchObject({
				changes: 0,
				received: 0,
			});
			expect(await rig.extraction.schedule(SCOPE)).toMatchObject({
				status: "idle",
				reason: "no_input",
			});
		}
		expect(commits - baseline).toBe(0);
		// Only the assistant spoke: still no input.
		await addMessage(life, "a1", "承知しました。", "assistant");
		await life.lifecycle.consumeSourceChanges(SCOPE);
		expect(await rig.extraction.schedule(SCOPE)).toMatchObject({
			status: "idle",
		});
		// Everything settled: no input either.
		await addMessage(life, "m1", "音声サービスは9月から利用できる。");
		await life.lifecycle.consumeSourceChanges(SCOPE);
		await drain(rig);
		expect(await rig.extraction.schedule(SCOPE)).toMatchObject({
			status: "idle",
			reason: "no_input",
		});
		stop();
		expect(rig.jobs.size).toBe(1);
		expect(rig.inference.state.executed).toBe(1);
		expect(rig.inference.state.captured).toHaveLength(1);
	} finally {
		await life.cleanup();
	}
});

test("input scanned while World is OFF is never delivered or extracted", async () => {
	const life = await started();
	try {
		await life.world.setEnabled(false);
		await addMessage(life, "m1", "音声サービスは9月から利用できる。");
		const off = await life.lifecycle.consumeSourceChanges(SCOPE);
		expect(off).toMatchObject({ received: 0, skippedInputs: 1 });
		expect(inboxRows(life)).toHaveLength(0);
		expect(stages(life).source).toMatchObject({ skipped: 1 });
		await life.world.setEnabled(true);
		await addMessage(life, "m2", "別の話題の発言。");
		await life.lifecycle.consumeSourceChanges(SCOPE);
		const rig = rigFor(life, empty);
		await drain(rig);
		// Only the input that arrived while World was ON was shown to the model.
		expect(rig.inference.state.prompts).toHaveLength(1);
		expect(rig.inference.state.prompts[0]).toContain("別の話題");
		expect(rig.inference.state.prompts[0]).not.toContain("9月");
		expect(mirrorRows(life).map((r) => r.state)).toEqual([
			"skipped",
			"applied",
		]);
		expect(inboxRows(life)).toHaveLength(1);
		// A skipped input is not applied: the applied position is World's, not the scan's.
		expect(stages(life).source.applied).toMatchObject({ applied: 1 });
	} finally {
		await life.cleanup();
	}
});

test("A28 a deterministic refusal of one receipt is recorded as skipped and never holds a retraction on the page", async () => {
	const life = await started();
	try {
		await addMessage(life, "m1", "音声サービスは9月から利用できる。");
		await addMessage(life, "m2", "秘密の発言: 暗証番号は1234。");
		await life.lifecycle.consumeSourceChanges(SCOPE);
		await addMessage(life, "m3", "三つ目の発言です。");
		// World already holds an event with m3's id but other content: it refuses the receipt.
		const ref = currentRef(life, "m3");
		const eventId = extractEventId(SCOPE, {
			source: {
				namespace: "conversation",
				kind: "message",
				id: "m3",
				representation: "text",
			},
			revision: ref.revision,
			digest: ref.digest,
		});
		const epoch = life.store.read((db) => life.world.restoreEpoch(db));
		expect(
			(
				await life.world.apply({
					access: ACCESS,
					scope: SCOPE,
					operationKey: "pre-1",
					clock: NOW,
					operation: {
						kind: "inbox.receive",
						feed: {
							scopeKeys: [SCOPE.scopeKey],
							kind: "source",
							cursorRestoreEpoch: epoch,
						},
						event: { eventId, seq: 99, payload: { other: true } },
						receivedCursor: "c-pre",
					},
				})
			).status,
		).toBe("applied");
		await life.conversation.retract({ messageId: "m2" });
		const report = await life.lifecycle.consumeSourceChanges(SCOPE);
		expect(report).toMatchObject({
			blocked: null,
			received: 0,
			skippedInputs: 1,
		});
		expect(report.forgets.map((f) => f.state)).toEqual(["complete"]);
		expect(mirrorRows(life).map((r) => [r.state, r.reason])).toEqual([
			["received", null],
			["skipped", "RECEIVE_REFUSED"],
		]);
		// The cursor moved: the retraction is not retried, nothing of m2 is left.
		expect(await life.lifecycle.consumeSourceChanges(SCOPE)).toMatchObject({
			changes: 0,
		});
	} finally {
		await life.cleanup();
	}
});
