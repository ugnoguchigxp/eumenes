import { afterEach, expect, test } from "bun:test";
import { setup, type Harness } from "./generation.fixture";

let h: Harness | undefined;
afterEach(async () => {
	await h?.close();
	h = undefined;
});

test("recover closes the retired TODOs and flushes the queue's cancelled jobs after the commit", async () => {
	h = await setup();
	h.state.steps.push({ text: "はい。" });
	const run = await h.say("こんにちは");
	h.store.write((db) => {
		db.run(
			`INSERT INTO dialogue_work(id, conversation_id, run_id, toolchain_id, toolchain_revision_id, execution, request, title,
			 status, revision, source_ref, dedupe_key, created_at, updated_at)
			 VALUES ('w1', 'main', ?, 'fake.image', 'toolchain:fake.image@1', 'task', 'request', 'title', 'todo', 1, 'exec-1', 'key-w1', ?, ?)`,
			[run.id, "2026-11-25T00:00:00.000Z", "2026-11-25T00:00:00.000Z"],
		);
	});
	const flushed: string[][] = [];
	h.queue.list = ((filter: { state?: string }) => ({
		items: filter.state === "cancel_requested" ? [{ id: "job-1" }] : [],
		nextCursor: null,
	})) as unknown as typeof h.queue.list;
	h.queue.flushCancellations = (jobs: string[]) => void flushed.push(jobs);
	await h.dialogue.recover();
	expect(
		h.store.read((db) =>
			db.query("SELECT outcome FROM dialogue_work WHERE id='w1'").get(),
		),
	).toEqual({ outcome: "interrupted" });
	expect(flushed).toEqual([["job-1"]]);
	// Nothing is left to cancel: the second start flushes nothing.
	await h.dialogue.recover();
	expect(flushed).toHaveLength(1);
});
