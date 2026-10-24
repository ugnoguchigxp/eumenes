import { afterEach, expect, test } from "bun:test";
import { setup, respond, type Harness } from "./generation.fixture";

/**
 * A forgotten execution source (its notice's request) revokes the notice run: a queued run is cancelled with its job,
 * and no later answer can be adopted for it (the ContextWindow specification, section 13).
 */
let h: Harness | undefined;
afterEach(async () => {
	await h?.close();
	h = undefined;
});

test("revoking a queued notice run cancels it and its job, and the steward is told it was cancelled", async () => {
	h = await setup({ autoStart: false });
	const requestId = crypto.randomUUID();
	const run = await h.dialogue.notify({
		requestId,
		conversationId: "main",
		text: "結果が届きました",
	});
	expect(run.status).toBe("queued");
	await h.store.write((db) =>
		h!.dialogue.revokeExecutionNoticeInTransaction(db, requestId),
	);
	const revoked = h.dialogue.get(run.id)!;
	expect(revoked).toMatchObject({
		status: "cancelled",
		error: "execution_source_forgotten",
	});
	expect(h.queue.get(run.jobId!)?.state).not.toBe("queued");
	expect(h.state.runEnds).toEqual([
		{ runId: run.id, conversationId: "main", state: "cancelled" },
	]);
	// Started afterwards, the cancelled run calls no model and adopts nothing.
	h.state.steps.push({ text: "遅い回答", calls: [respond()] });
	h.start();
	await h.queue.tick();
	expect(h.state.calls).toHaveLength(0);
	expect(h.dialogue.answerText(run.id)).toBeNull();
	expect(h.conversation.get("main").messages.map((m) => m.role)).toEqual([
		"user",
	]);
});

test("revoking a notice that already completed changes nothing", async () => {
	h = await setup();
	h.state.steps.push({ text: "お知らせです。", calls: [respond()] });
	const requestId = crypto.randomUUID();
	const run = await h.dialogue.notify({
		requestId,
		conversationId: "main",
		text: "タイマーが終わりました",
	});
	await h.dialogue.waitForTerminal(run.id);
	expect(h.dialogue.get(run.id)?.status).toBe("completed");
	await h.store.write((db) =>
		h!.dialogue.revokeExecutionNoticeInTransaction(db, requestId),
	);
	expect(h.dialogue.get(run.id)?.status).toBe("completed");
	expect(h.dialogue.answerText(run.id)).toBe("お知らせです。");
});

test("revoking an unknown source is a no-op", async () => {
	h = await setup({ autoStart: false });
	await h.store.write((db) =>
		h!.dialogue.revokeExecutionNoticeInTransaction(db, "no-such-request"),
	);
	expect(h.state.runEnds).toEqual([]);
});
