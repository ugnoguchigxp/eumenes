import { afterEach, expect, test } from "bun:test";
import { IMAGE, setup, type Harness } from "./specialist.fixture";

const open: Harness[] = [];
afterEach(async () => {
	for (const h of open.splice(0)) await h.close();
});
async function harness(options: Parameters<typeof setup>[0] = {}) {
	const h = await setup(options);
	open.push(h);
	return h;
}

const DAY = 24 * 60 * 60 * 1000;
const reply = (text: string) => ({ action: "reply", text });
const invoke = (title: string) => ({
	action: "invoke",
	tool: "draft.apply",
	arguments: { title },
});
const main = (h: Harness, ...texts: string[]) =>
	h.state.steps.push(...texts.map((text) => ({ text })));
/** The records of the conversation model's latest call, by source. */
const recordOf = (h: Harness, source: string) =>
	(h.material(h.state.calls.length - 1).now.records ?? []).find(
		(r: { source: string }) => r.source === source,
	);
async function startDirty(h: Harness) {
	h.handOver({ request: "アンケートを作って" });
	h.state.specialist.push(invoke("アンケート"), reply("作りました"));
	return h.ask("アンケートを作って");
}
const command = (
	h: Harness,
	kind: "return" | "resume" | "discard" | "close",
	session: { id: string; revision: number },
	requestId = crypto.randomUUID(),
) =>
	h.dialogue.specialistCommand(session.id, kind, {
		requestId,
		expectedRevision: session.revision,
	});
const code = async (promise: Promise<unknown>) =>
	promise.then(
		() => "ok",
		(error: Error) => error.message,
	);

test("expiry is the session's only one: polling never extends it, an accepted utterance does", async () => {
	const h = await harness();
	await startDirty(h);
	const before = (await h.session())!.expiresAt;
	await h.session();
	await h.session();
	expect((await h.session())!.expiresAt).toBe(before);
	h.state.specialist.push(reply("はい"));
	await h.ask("続き");
	expect(Date.parse((await h.session())!.expiresAt)).toBeGreaterThanOrEqual(
		Date.parse(before),
	);
});

test("an expired session is not extended by a new utterance: it ends and the utterance goes the ordinary way", async () => {
	const h = await harness();
	await startDirty(h);
	const modelCalls = h.state.calls.length;
	h.state.offsetMs += DAY + 60_000;
	main(h, "通常の返答");
	const run = await h.ask("まだ作業中？");
	expect(run.specialistSessionId).toBeNull();
	expect(run.status).toBe("completed");
	expect(h.answerText(run.id)).toBe("通常の返答");
	expect(h.state.calls.length).toBe(modelCalls + 1);
	expect(h.state.calls.at(-1)!.messages.at(-1)!.content).toBe("まだ作業中？");
	expect(await h.session()).toBeNull();
	expect(h.work()[0]!.ended).toBe(true);
	expect(h.state.calledPort).toContain("end:discard");
	const ended = h.rows(
		"SELECT state, end_reason FROM dialogue_specialist_sessions",
	);
	expect(ended).toEqual([{ state: "ended", end_reason: "expired" }]);
	// The conversation agent hears of it once, with that very utterance.
	expect(recordOf(h, "specialist.work").data.ended).toMatchObject({
		reason: "expired",
	});
	main(h, "はい");
	await h.ask("次の話");
	expect(recordOf(h, "specialist.work")).toBeUndefined();
});

test("a turn that outlives the session's expiry is not adopted", async () => {
	const h = await harness();
	await startDirty(h);
	let release!: () => void;
	h.state.gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	h.state.specialist.push(reply("遅い返答"));
	const run = await h.say("続き");
	await h.until(() => h.state.specialistPrompts.length === 3);
	h.state.offsetMs += DAY + 60_000;
	release();
	await h.finished(run.id);
	expect(h.dialogue.get(run.id)).toMatchObject({
		status: "failed",
		error: "specialist_session_expired",
	});
	await h.dialogue.sweepSpecialistSessions();
	expect(await h.session()).toBeNull();
});

test("the sweep ends expired sessions; a refusing domain leaves them closing and the next sweep retries the same end", async () => {
	const h = await harness();
	await startDirty(h);
	h.state.offsetMs += DAY + 60_000;
	h.state.endWorkFails = true;
	await h.dialogue.sweepSpecialistSessions();
	const closing = (await h.session())!;
	expect(closing.state).toBe("closing");
	// The domain keeps its work: nothing was half ended.
	expect(h.work()[0]!.ended).toBe(false);
	// A closing session does not address utterances.
	main(h, "通常です");
	const run = await h.ask("こんにちは");
	expect(run.specialistSessionId).toBeNull();
	// Entering it any other way is refused as well.
	expect(await code(command(h, "resume", closing))).toBe("session_closing");
	h.state.endWorkFails = false;
	await h.dialogue.sweepSpecialistSessions();
	expect(await h.session()).toBeNull();
	expect(h.work()[0]!.ended).toBe(true);
	expect(
		h.rows("SELECT state, end_reason FROM dialogue_specialist_sessions"),
	).toEqual([{ state: "ended", end_reason: "expired" }]);
	// Sweeping again repeats nothing.
	await h.dialogue.sweepSpecialistSessions();
	expect(h.state.calledPort.filter((c) => c === "end:discard")).toHaveLength(1);
});

test("a suspended work that was saved meanwhile is ended by the sweep, an unsaved one is kept", async () => {
	const h = await harness();
	await startDirty(h);
	h.state.specialist.push({
		action: "return",
		forward: false,
		text: "戻ります",
	});
	await h.ask("戻って");
	await h.dialogue.sweepSpecialistSessions();
	expect((await h.session())!.state).toBe("suspended");
	h.work()[0]!.dirty = false;
	await h.dialogue.sweepSpecialistSessions();
	expect(await h.session()).toBeNull();
	expect(
		h.rows("SELECT end_reason FROM dialogue_specialist_sessions")[0]!
			.end_reason,
	).toBe("closed");
});

test("recovery ends every session that was not ended as restarted", async () => {
	const h = await harness();
	await startDirty(h);
	await h.dialogue.recoverSpecialistSessions();
	expect(await h.session()).toBeNull();
	expect(h.work()[0]!.ended).toBe(true);
	expect(
		h.rows("SELECT end_reason FROM dialogue_specialist_sessions")[0]!
			.end_reason,
	).toBe("restarted");
	expect(h.state.released).toHaveLength(1);
});

test("a pinned form submit is the main conversation's: an active session does not take it", async () => {
	const h = await harness();
	await startDirty(h);
	const session = (await h.session())!;
	const run = await h.dialogue.submit({
		requestId: crypto.randomUUID(),
		conversationId: "main",
		text: "猫を描いて",
		presentation: "artifact",
		toolchainId: IMAGE.id,
	});
	expect(run.specialistSessionId).toBeNull();
	expect(run.pinnedToolchainId).toBe(IMAGE.id);
	const job = h.rows(
		"SELECT kind, payload_json FROM queue_jobs WHERE id = ?",
		run.jobId!,
	)[0];
	expect(job.kind).not.toBe("dialogue.specialist-turn");
	expect(JSON.parse(job.payload_json)).toEqual({ runId: run.id });
	// The submit is handed to the image toolchain: the run waits behind its job, with no model call for it.
	const modelCalls = h.state.calls.length;
	await h.until(() => {
		const now = h.dialogue.get(run.id)!;
		return now.status === "queued" && now.jobId !== run.jobId;
	});
	expect(h.state.calls).toHaveLength(modelCalls);
	// The session is untouched: no turn was begun for the pinned submit.
	expect(await h.session()).toMatchObject({
		id: session.id,
		state: "active",
		activeRunId: null,
	});
	expect(h.work()[0]!.holder).toBeNull();
});

test("commands: revision guard, idempotent by requestId, return suspends or ends, resume advances the epoch", async () => {
	const h = await harness();
	await startDirty(h);
	const session = (await h.session())!;
	expect(await code(command(h, "return", { ...session, revision: 99 }))).toBe(
		"revision_conflict",
	);
	expect(await code(command(h, "resume", session))).toBe(
		"session_not_suspended",
	);
	const requestId = crypto.randomUUID();
	const first = await command(h, "return", session, requestId);
	expect(first.session).toMatchObject({ state: "suspended", dirty: true });
	// The same request returns the first result and changes nothing; another kind with that id conflicts.
	const replay = await command(h, "return", session, requestId);
	expect(replay).toEqual(first);
	expect(await code(command(h, "discard", session, requestId))).toBe(
		"request_conflict",
	);
	const suspended = (await h.session())!;
	expect(suspended.revision).toBe(first.session.revision);
	const resumed = await command(h, "resume", suspended);
	expect(resumed.session).toMatchObject({ state: "active", epoch: 2 });
	expect(await code(command(h, "close", resumed.session))).toBe("work_unsaved");
	const discarded = await command(h, "discard", resumed.session);
	expect(discarded.session).toMatchObject({
		state: "ended",
		endReason: "discarded",
	});
	expect(h.work()[0]!.ended).toBe(true);
	expect(await h.session()).toBeNull();
	expect(await code(command(h, "close", discarded.session))).toBe(
		"session_ended",
	);
	expect(
		await code(
			h.dialogue.specialistCommand("nope", "close", {
				requestId: crypto.randomUUID(),
				expectedRevision: 0,
			}),
		),
	).toBe("specialist_session_not_found");
});

test("closing a clean work ends it; returning a clean one ends it too", async () => {
	const h = await harness();
	h.handOver({ request: "相談" });
	h.state.specialist.push(reply("どうぞ"));
	await h.ask("相談");
	const session = (await h.session())!;
	const closed = await command(h, "close", session);
	expect(closed.session).toMatchObject({ state: "ended", endReason: "closed" });
	h.handOver({ request: "もう一度" });
	h.state.specialist.push(reply("どうぞ"));
	await h.ask("もう一度");
	const second = (await h.session())!;
	const returned = await command(h, "return", second);
	expect(returned.session).toMatchObject({
		state: "ended",
		endReason: "returned",
	});
});

test("return cancels the turn in flight; the work is free and a late result is not adopted", async () => {
	const h = await harness();
	await startDirty(h);
	let release!: () => void;
	h.state.gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	h.state.specialist.push(invoke("遅い変更"), reply("遅い返答"));
	const run = await h.say("変えて");
	await h.until(() => h.dialogue.get(run.id)?.status === "running");
	const busy = (await h.session())!;
	expect(busy).toMatchObject({ busy: true, activeRunId: run.id });
	const returned = await command(h, "return", busy);
	expect(returned.session).toMatchObject({ state: "suspended", busy: false });
	await h.finished(run.id);
	expect(h.dialogue.get(run.id)!.status).toBe("cancelled");
	release();
	await new Promise((resolve) => setTimeout(resolve, 50));
	// The cancelled turn changed nothing and answered nothing.
	expect(h.state.invocations).toHaveLength(1);
	expect(h.work()[0]!.holder).toBeNull();
	expect(h.dialogue.get(run.id)!.answerMessageId).toBeNull();
});

test("an utterance while a turn holds the work is queued behind it, in order, and takes the work when its turn starts", async () => {
	const h = await harness();
	await startDirty(h);
	let release!: () => void;
	h.state.gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	h.state.specialist.push(reply("一つ目の返答"), reply("二つ目の返答"));
	const first = await h.say("一つ目");
	await h.until(() => h.dialogue.get(first.id)?.status === "running");
	const second = await h.say("二つ目");
	expect(second.status).toBe("queued");
	expect(second.specialistSessionId).toBe(first.specialistSessionId);
	// The first turn still holds the work; the queued one is not the holder yet.
	expect((await h.session())!.activeRunId).toBe(first.id);
	expect(h.work()[0]!.holder).toBe(first.id);
	release();
	await h.finished(first.id);
	await h.finished(second.id);
	expect(h.dialogue.get(first.id)!.status).toBe("completed");
	expect(h.dialogue.get(second.id)!.status).toBe("completed");
	expect(
		h.conversation.message(h.dialogue.get(second.id)!.answerMessageId!)!.text,
	).toBe("二つ目の返答");
	// The second turn saw the first one's exchange.
	expect(
		h.state.specialistPrompts
			.at(-1)!
			.map((m) => m.content)
			.join("\n"),
	).toContain("一つ目の返答");
	expect((await h.session())!.activeRunId).toBeNull();
	expect(h.work()[0]!.holder).toBeNull();
});

test("the work is never free between two queued turns; a return command withdraws the turn in flight and hands the queued utterances to the conversation agent in order", async () => {
	const h = await harness();
	await startDirty(h);
	let release!: () => void;
	h.state.gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	h.state.specialist.push(reply("一つ目の返答"));
	const first = await h.say("一つ目");
	await h.until(() => h.dialogue.get(first.id)?.status === "running");
	const second = await h.say("二つ目");
	const third = await h.say("三つ目");
	const chain = (await h.session())!;
	const modelCalls = h.state.calls.length;
	main(h, "二つ目と三つ目への返答");
	const returned = await command(h, "return", chain);
	expect(returned.session).toMatchObject({ state: "suspended", busy: false });
	expect(h.dialogue.get(first.id)!.status).toBe("cancelled");
	release();
	await h.finished(second.id);
	await h.finished(third.id);
	// Both utterances are the conversation agent's unhandled ones: one generation takes them, in order.
	expect(h.state.calls.length).toBe(modelCalls + 1);
	const newest = h.state.calls
		.at(-1)!
		.messages.slice(2)
		.map((m) => m.content);
	expect(newest).toHaveLength(2);
	expect(newest[0]).toContain("二つ目");
	expect(newest[1]).toContain("三つ目");
	const done = [second, third].map((run) => h.dialogue.get(run.id)!);
	expect(done.every((run) => run.specialistSessionId === null)).toBe(true);
	expect(done.filter((run) => run.status === "completed")).toHaveLength(1);
	expect(h.work()[0]!.holder).toBeNull();
	expect(h.state.specialistPrompts.length).toBe(3);
});

test("when the specialist leaves, utterances queued behind it go to the conversation agent instead of being lost", async () => {
	const h = await harness();
	await startDirty(h);
	let release!: () => void;
	h.state.gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	h.state.specialist.push({
		action: "return",
		forward: false,
		text: "戻ります",
	});
	const first = await h.say("戻って");
	await h.until(() => h.dialogue.get(first.id)?.status === "running");
	main(h, "通常の返答");
	const second = await h.say("天気は？");
	release();
	await h.finished(first.id);
	await h.finished(second.id);
	const done = h.dialogue.get(second.id)!;
	expect(done.status).toBe("completed");
	expect(done.specialistSessionId).toBeNull();
	expect(h.answerText(second.id)).toBe("通常の返答");
	expect(h.blocked()).not.toContain(done.inputMessageId);
	expect((await h.session())!.state).toBe("suspended");
});

test("an expired session with a turn in flight is withdrawn when the next utterance ends it", async () => {
	const h = await harness();
	await startDirty(h);
	let release!: () => void;
	h.state.gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	h.state.specialist.push(reply("遅い返答"));
	const slow = await h.say("遅い依頼");
	await h.until(() => h.dialogue.get(slow.id)?.status === "running");
	h.state.offsetMs += DAY + 60_000;
	main(h, "通常です");
	const next = await h.ask("こんにちは");
	expect(next.specialistSessionId).toBeNull();
	await h.finished(slow.id);
	expect(h.dialogue.get(slow.id)!.status).toBe("cancelled");
	release();
	await new Promise((resolve) => setTimeout(resolve, 50));
	expect(h.dialogue.get(slow.id)!.answerMessageId).toBeNull();
	expect(h.work()[0]!.ended).toBe(true);
});

test("the live check holds only for an active or suspended session that has not expired", async () => {
	const h = await harness();
	await startDirty(h);
	const session = (await h.session())!;
	const live = () =>
		h.store.read((db) =>
			h.dialogue.specialistSessionLiveInTransaction(db, session.id),
		);
	expect(live()).toBe(true);
	await command(h, "return", session);
	expect(live()).toBe(true);
	h.state.offsetMs += DAY + 60_000;
	expect(live()).toBe(false);
	h.state.offsetMs = 0;
	h.state.endWorkFails = true;
	h.state.offsetMs += DAY + 60_000;
	await h.dialogue.sweepSpecialistSessions();
	expect(live()).toBe(false);
	expect(
		h.store.read((db) =>
			h.dialogue.specialistSessionLiveInTransaction(db, "nope"),
		),
	).toBe(false);
});

test("after the specialist leaves, the conversation's own exchanges are not blocked from memory and are learned from", async () => {
	const h = await harness();
	await startDirty(h);
	h.state.specialist.push({
		action: "return",
		forward: false,
		text: "戻ります",
	});
	const left = await h.ask("戻って");
	main(h, "晴れです");
	const run = await h.ask("天気は？");
	expect(run.status).toBe("completed");
	const blocked = new Set(h.blocked());
	expect(blocked.has(left.inputMessageId)).toBe(true);
	expect(blocked.has(run.inputMessageId)).toBe(false);
	expect(blocked.has(run.answerMessageId!)).toBe(false);
	expect(h.state.runEnds.map((e) => e.runId)).toContain(run.id);
	expect(h.state.runEnds.map((e) => e.runId)).not.toContain(left.id);
});
