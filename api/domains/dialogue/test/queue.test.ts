import { afterEach, expect, test } from "bun:test";
import { waitFor } from "../../../infrastructure/wait-for";
import { createDialogueService } from "..";
import { createQueue } from "../../queue";
import { createScheduler } from "../../scheduler";
import { setup, type Harness } from "./generation.fixture";
import { testConversationAgent } from "./conversation-agent.fixture";

/**
 * Ordering, isolation and recovery of the conversation's runs (the ContextWindow specification, sections 8.2 and
 * 12.2): a generation handles the utterances pending when it is claimed, a later input waits for its own run, and
 * a run cut short by a restart is interrupted, never resumed by the old owner.
 */
let h: Harness | undefined;
afterEach(async () => {
	await h?.close();
	h = undefined;
});

test("a run handles the utterances pending at its claim; a later input waits for its own run", async () => {
	h = await setup({ autoStart: false });
	let release!: () => void;
	h.state.gate = new Promise<void>((resolve) => (release = resolve));
	h.state.steps.push({ text: "ansA" });
	const a = await h.dialogue.submit({
		requestId: crypto.randomUUID(),
		conversationId: "main",
		text: "A",
	});
	h.start();
	await waitFor(() => h!.state.calls.length === 1);
	// B arrives while A's generation is in flight: it is not in A's messages.
	const b = await h.dialogue.submit({
		requestId: crypto.randomUUID(),
		conversationId: "main",
		text: "B",
	});
	expect(h.state.calls[0]!.messages.at(-1)!.content).toBe("A");
	expect(h.dialogue.get(b.id)?.status).toBe("queued");
	h.state.steps.push({ text: "ansB" });
	release();
	await waitFor(() => h!.dialogue.get(a.id)?.status === "completed");
	await waitFor(() => h!.dialogue.get(b.id)?.status === "completed");
	expect(h.dialogue.answerText(b.id)).toBe("ansB");
	// B's own call sees A's exchange as history, then B.
	expect(h.state.calls[1]!.messages.at(-1)!.content).toBe("B");
	expect(h.state.calls[1]!.messages[1]!.content).toContain("ansA");
});

test("utterances pending together are one generation; a run with nothing left to handle ends as handled", async () => {
	h = await setup({ autoStart: false });
	h.state.steps.push({ text: "まとめて。" });
	const a = await h.dialogue.submit({
		requestId: crypto.randomUUID(),
		conversationId: "main",
		text: "A",
	});
	const b = await h.dialogue.submit({
		requestId: crypto.randomUUID(),
		conversationId: "main",
		text: "B",
	});
	h.start();
	await waitFor(() => h!.dialogue.get(a.id)?.status === "completed");
	await waitFor(() => h!.dialogue.get(b.id)?.status === "cancelled");
	// One call carried both utterances, each as its own newest message, with the time it was said.
	expect(h.state.calls).toHaveLength(1);
	// System, the material document and `<now>` come first; the newest messages follow (layout specification, section 5).
	const newest = h.state.calls[0]!.messages.slice(3).map((m) => m.content);
	expect(newest).toHaveLength(2);
	expect(newest[0]).toMatch(/^\[.+\] A$/);
	expect(newest[1]).toMatch(/^\[.+\] B$/);
	expect(h.dialogue.get(b.id)).toMatchObject({
		status: "cancelled",
		error: "utterance_handled",
	});
	expect(h.state.calls).toHaveLength(1);
});

test("full queue rejects the submit and stores neither message nor run", async () => {
	h = await setup({
		autoStart: false,
		queue: { limits: { total: 1, background: 1, scope: 1 } },
	});
	await h.dialogue.submit({
		requestId: crypto.randomUUID(),
		conversationId: "main",
		text: "one",
	});
	await expect(
		h.dialogue.submit({
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: "two",
		}),
	).rejects.toThrow("queue_full");
	expect(h.conversation.get("main").messages.map((m) => m.text)).toEqual([
		"one",
	]);
	expect(h.dialogue.list("main")).toHaveLength(1);
});

test("restart: queued runs continue, a running run is interrupted, a late result from the old owner is rejected", async () => {
	h = await setup({ autoStart: false });
	let release!: () => void;
	h.state.gate = new Promise<void>((resolve) => (release = resolve));
	h.state.steps.push({ text: "old" });
	const a = await h.dialogue.submit({
		requestId: crypto.randomUUID(),
		conversationId: "main",
		text: "A",
	});
	const b = await h.dialogue.submit({
		requestId: crypto.randomUUID(),
		conversationId: "main",
		text: "B",
	});
	await h.queue.tick(); // claims A only
	await waitFor(() => h!.state.calls.length === 1);
	expect(h.dialogue.get(a.id)?.status).toBe("running");
	// "Restart": a new queue and service over the same database.
	const queue2 = createQueue(h.store);
	const dialogue2 = createDialogueService({
		conversationAgent: testConversationAgent,
		store: h.store,
		conversation: h.conversation,
		larm: h.larm,
		queue: queue2,
		continuity: h.continuity,
		clock: () => new Date().toISOString(),
	});
	await dialogue2.recover();
	expect(await queue2.recover()).toBe(1);
	expect(dialogue2.get(a.id)?.status).toBe("interrupted");
	expect(dialogue2.get(b.id)?.status).toBe("queued");
	h.state.steps.push({ text: "ansB" });
	queue2.start();
	await waitFor(() => h!.state.calls.length === 2);
	// The old owner's answer arrives late: it is not adopted.
	release();
	for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
	expect(dialogue2.get(a.id)?.status).toBe("interrupted");
	await waitFor(() => dialogue2.get(b.id)?.status === "completed");
	expect(
		h.conversation
			.get("main")
			.messages.filter((m) => m.role === "assistant")
			.map((m) => m.text),
	).toEqual(["ansB"]);
	await queue2.close(100);
});

test("runs from before the queue existed are interrupted, not given a new job", async () => {
	h = await setup({ autoStart: false });
	const now = new Date().toISOString();
	await h.store.write((db) => {
		h!.conversation.appendInTransaction(db, {
			id: "m",
			conversationId: "main",
			role: "user",
			text: "old",
			createdAt: now,
			runId: "legacy",
		});
		db.query(
			"INSERT INTO dialogue_runs (id,request_id,conversation_id,status,revision,input_message_id,created_at,updated_at,seq) VALUES ('legacy','r','main','running',0,'m',?,?,99)",
		).run(now, now);
	});
	await h.dialogue.recover();
	expect(h.dialogue.get("legacy")?.status).toBe("interrupted");
	expect(h.dialogue.get("legacy")?.jobId).toBeNull();
});

test("a scheduled prompt creates exactly one background run per occurrence; an interactive input is claimed first", async () => {
	h = await setup({ autoStart: false });
	const clock = { t: Date.parse("2026-02-01T00:00:00Z") };
	const scheduler = createScheduler(h.store, h.queue, {
		now: () => clock.t,
		sleep: () => new Promise(() => {}),
	});
	scheduler.registerTarget(h.dialogue.promptTarget);
	const schedule = await scheduler.create({
		requestId: crypto.randomUUID(),
		target: {
			kind: "dialogue.prompt",
			payload: { conversationId: "daily", text: "朝の確認" },
		},
		schedule: { type: "once", at: "2026-02-01T00:00:00Z" },
		misfirePolicy: "coalesce",
		graceMs: 1000,
	});
	await scheduler.tick();
	await scheduler.tick();
	const runs = h.dialogue.list("daily");
	expect(runs).toHaveLength(1);
	expect(runs[0]).toMatchObject({
		sourceKind: "schedule",
		scheduleId: schedule.id,
		status: "queued",
	});
	expect(h.conversation.get("daily").messages.map((m) => m.text)).toEqual([
		"朝の確認",
	]);
	expect(h.queue.list({ kind: "dialogue.generate" }).items[0]?.lane).toBe(
		"background",
	);
	// An interactive run in another conversation overtakes the waiting background run.
	const live = await h.dialogue.submit({
		requestId: crypto.randomUUID(),
		conversationId: "other",
		text: "今すぐ",
	});
	h.state.steps.push({ text: "はい" }, { text: "おはようございます" });
	let release!: () => void;
	h.state.gate = new Promise<void>((resolve) => (release = resolve));
	await h.queue.tick();
	await waitFor(() => h!.state.calls.length === 1);
	expect(h.state.calls[0]!.messages.at(-1)!.content).toBe("今すぐ");
	expect(h.dialogue.get(live.id)?.status).toBe("running");
	expect(h.dialogue.get(runs[0]!.id)?.status).toBe("queued");
	release();
	await waitFor(() => h!.dialogue.get(live.id)?.status === "completed");
	await h.queue.tick();
	await waitFor(() => h!.state.calls.length === 2);
	await waitFor(() => h!.dialogue.get(runs[0]!.id)?.status === "completed");
	expect(scheduler.listOccurrences(schedule.id).items[0]?.jobState).toBe(
		"completed",
	);
});

test("waitForTerminal honours its own timeout and an abort, and never cancels the run", async () => {
	h = await setup({ autoStart: false });
	const run = await h.dialogue.submit({
		requestId: crypto.randomUUID(),
		conversationId: "main",
		text: "wait",
	});
	const started = Date.now();
	const waited = await h.dialogue.waitForTerminal(run.id, {
		timeoutMs: 40,
		pollMs: 10,
	});
	expect(waited?.status).toBe("queued");
	expect(Date.now() - started).toBeLessThan(500);
	const controller = new AbortController();
	controller.abort();
	expect(
		(await h.dialogue.waitForTerminal(run.id, { signal: controller.signal }))
			?.status,
	).toBe("queued");
	expect(h.dialogue.get(run.id)?.status).toBe("queued");
});

test("a rejected answer adoption fails both the run and its queue job, and adds no message", async () => {
	h = await setup();
	h.state.acceptAllowed = false;
	h.state.steps.push({ text: "revoked answer" });
	const run = await h.dialogue.submit({
		requestId: crypto.randomUUID(),
		conversationId: "main",
		text: "question",
	});
	await waitFor(
		() =>
			!["queued", "running"].includes(h!.dialogue.get(run.id)?.status ?? ""),
	);
	expect(h.dialogue.get(run.id)?.status).toBe("failed");
	expect(h.dialogue.get(run.id)?.error).toBe("permission_revoked");
	expect(h.queue.get(run.jobId!)?.state).toBe("failed");
	expect(h.queue.get(run.jobId!)?.errorCode).toBe("permission_revoked");
	expect(h.conversation.get("main").messages.map((m) => m.text)).toEqual([
		"question",
	]);
});

test("only an adopted, confident motion labels an answer; a judgment of a cancelled run is rejected", async () => {
	h = await setup({ autoStart: false });
	let release!: () => void;
	h.state.gate = new Promise<void>((resolve) => (release = resolve));
	h.state.steps.push({ text: "よかったですね。" });
	const run = await h.dialogue.submit({
		requestId: crypto.randomUUID(),
		conversationId: "main",
		text: "良い知らせ",
	});
	h.start();
	await waitFor(() => h!.state.calls.length === 1);
	const decision = {
		id: crypto.randomUUID(),
		source: "system-one" as const,
		motion: "joyful" as const,
		tone: "natural" as const,
		confidence: 0.2,
		motionConfidence: 0.9,
		toneConfidence: 0.2,
		latencyMs: 10,
	};
	for (const delivery of [
		{ ...decision, source: "fallback" as const },
		{ ...decision, motionConfidence: 0.2 },
	])
		expect(
			await h.store.write((db) =>
				h!.dialogue.recordAnswerDeliveryInTransaction(db, run.id, delivery),
			),
		).toBe(false);
	expect(
		await h.store.write((db) =>
			h!.dialogue.recordAnswerDeliveryInTransaction(db, run.id, decision),
		),
	).toBe(true);
	release();
	await waitFor(() => h!.dialogue.get(run.id)?.status === "completed");
	expect(h.conversation.get("main").messages.at(-1)).toMatchObject({
		text: "よかったですね。",
		avatarMotion: "joyful",
	});
	// A run cancelled before its answer is adopted takes no judgment.
	h.state.gate = new Promise<void>(() => {});
	const cancelled = await h.dialogue.submit({
		requestId: crypto.randomUUID(),
		conversationId: "main",
		text: "取消",
	});
	await waitFor(() => h!.state.calls.length === 2);
	await h.dialogue.cancel(cancelled.id);
	expect(
		await h.store.write((db) =>
			h!.dialogue.recordAnswerDeliveryInTransaction(db, cancelled.id, decision),
		),
	).toBe(false);
});

test("the emotion context holds the earlier turns and the complete answer, never a later input", async () => {
	h = await setup({ autoStart: false });
	let release!: () => void;
	h.state.gate = new Promise<void>((resolve) => (release = resolve));
	h.state.steps.push({ text: "最初への完全な返答。" });
	const a = await h.dialogue.submit({
		requestId: crypto.randomUUID(),
		conversationId: "main",
		text: "最初の話",
	});
	h.start();
	await waitFor(() => h!.state.calls.length === 1);
	const b = await h.dialogue.submit({
		requestId: crypto.randomUUID(),
		conversationId: "main",
		text: "後の話",
	});
	release();
	await waitFor(() => h!.dialogue.get(a.id)?.status === "completed");
	expect(h.dialogue.answerContext(a.id)).toEqual({
		answer: "最初への完全な返答。",
		turns: [{ role: "user", text: "最初の話" }],
	});
	await h.dialogue.cancel(b.id);
	expect(h.dialogue.answerContext(b.id)).toBeNull();
});
