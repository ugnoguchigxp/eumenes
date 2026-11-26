import { afterEach, expect, test } from "bun:test";
import { insert } from "../repository";
import { reply, setup, type Harness } from "./generation.fixture";

/**
 * The one place a run ends (the ContextWindow specification, sections 9 and 10.1): the steward is told how it ended,
 * once.
 */
let h: Harness | undefined;
afterEach(async () => {
	await h?.close();
	h = undefined;
});

test("a completed run tells the steward once, with its conversation and the completed state", async () => {
	h = await setup();
	h.state.steps.push(...reply("こんにちは。"));
	const run = await h.say("やあ");
	expect(run.status).toBe("completed");
	expect(h.state.runEnds).toEqual([
		{ runId: run.id, conversationId: "main", state: "completed" },
	]);
});

test("a failed run tells the steward its failure", async () => {
	h = await setup();
	// No scripted step: the model call fails, the run ends as failed.
	const run = await h.say("予算は3万円以内", "failed");
	expect(run.error).toBe("fixture_step_missing");
	expect(h.state.runEnds).toEqual([
		{ runId: run.id, conversationId: "main", state: "failed" },
	]);
});

test("stopping the reply of a run cancels it", async () => {
	h = await setup({ autoStart: false });
	const run = await h.dialogue.submit({
		requestId: crypto.randomUUID(),
		conversationId: "main",
		text: "やあ",
	});
	expect((await h.dialogue.stopReply(run.id))?.status).toBe("cancelled");
});

test("a run that already completed is not ended or told twice by a later cancel", async () => {
	h = await setup();
	h.state.steps.push(...reply("一度だけ。"));
	const run = await h.say("一度だけ");
	await h.dialogue.cancel(run.id);
	expect(h.dialogue.get(run.id)?.status).toBe("completed");
	expect(h.state.runEnds.filter((e) => e.runId === run.id)).toHaveLength(1);
});

test("a run left without a job when the backend restarts is interrupted and the steward is told", async () => {
	h = await setup({ autoStart: false });
	await h.store.write((db) => {
		h!.conversation.appendInTransaction(db, {
			id: "u-orphan",
			conversationId: "main",
			role: "user",
			text: "途中で止まった発言",
			createdAt: "2026-10-13T00:00:00.000Z",
			runId: "r-orphan",
		});
		insert(db, {
			id: "r-orphan",
			agentTaskId: null,
			specialistSessionId: null,
			requestId: "req-orphan",
			conversationId: "main",
			utteranceId: null,
			status: "running",
			revision: 1,
			inputMessageId: "u-orphan",
			answerMessageId: null,
			error: null,
			jobId: null,
			deadlineAt: null,
			sourceKind: "manual",
			scheduleId: null,
			occurrenceId: null,
			createdAt: "2026-10-13T00:00:00.000Z",
			updatedAt: "2026-10-13T00:00:00.000Z",
		});
	});
	await h.dialogue.recover();
	expect(h.dialogue.get("r-orphan")?.status).toBe("interrupted");
	expect(h.state.runEnds).toEqual([
		{ runId: "r-orphan", conversationId: "main", state: "interrupted" },
	]);
});
