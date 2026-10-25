import { afterEach, expect, test } from "bun:test";
import { insert } from "../repository";
import { IMAGE, setup, type Harness } from "./generation.fixture";

/**
 * The one place a run ends (the ContextWindow specification, sections 9 and 10.1): the steward is told how it ended,
 * once; the TODO a run was still waiting for ends with it, unless the run completed.
 */
let h: Harness | undefined;
afterEach(async () => {
	await h?.close();
	h = undefined;
});

test("a completed run tells the steward once, with its conversation and the completed state", async () => {
	h = await setup();
	h.state.steps.push({ text: "こんにちは。" });
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

test("a cancelled run tells the steward it was cancelled, and its waiting TODO ends with it", async () => {
	h = await setup();
	h.state.steps.push(
		{ calls: [{ name: "find_toolchain", args: { query: "絵を描く" } }] },
		{
			calls: [
				{
					name: "delegate",
					args: {
						mode: "execute",
						toolchain: IMAGE.id,
						request: "猫の絵",
						impact: "create",
						announcement: "描きますね。",
					},
				},
			],
		},
	);
	const waiting = await h.say("猫の絵を描いて", "queued");
	const [todo] = h.todos();
	expect(todo).toMatchObject({ status: "todo" });
	await h.dialogue.cancel(waiting.id);
	expect(h.dialogue.get(waiting.id)?.status).toBe("cancelled");
	// The TODO ends with the run as cancelled; cancelled work is not reported back, so it is archived at once.
	expect(h.todos()).toEqual([]);
	expect(h.state.runEnds.filter((e) => e.runId === waiting.id)).toEqual([
		{ runId: waiting.id, conversationId: "main", state: "cancelled" },
	]);
});

test("a run that already completed is not ended or told twice by a later cancel", async () => {
	h = await setup();
	h.state.steps.push({ text: "一度だけ。" });
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
