import { afterEach, expect, test } from "bun:test";
import { insertWork, updateWork } from "../repository/work";
import { setup, type Harness } from "./generation.fixture";

let h: Harness;
afterEach(async () => {
	await h?.close();
});
async function fixture() {
	h = await setup();
	await h.store.write((db) => {
		insertWork(db, {
			id: "todo",
			conversationId: "main",
			runId: "work",
			toolchainId: "test",
			toolchainRevisionId: "toolchain:test@1",
			execution: "task",
			request: "依頼",
			title: "依頼",
			sourceRef: null,
			dedupeKey: "todo",
			messageIds: [],
			createdAt: new Date().toISOString(),
		});
		updateWork(
			db,
			"todo",
			1,
			{ status: "done", outcome: "succeeded", result: { summary: "結果" } },
			new Date().toISOString(),
		);
	});
}
async function report(id = "message") {
	await h.store.write((db) => {
		h.conversation.appendInTransaction(db, {
			id,
			conversationId: "main",
			role: "assistant",
			text: "できました。",
			runId: null,
			createdAt: new Date().toISOString(),
		});
		h.dialogue.recordSpontaneousInTransaction(db, {
			conversationId: "main",
			messageId: id,
			text: "できました。",
			at: new Date().toISOString(),
			todoRefs: ["todo"],
		});
	});
}
const heard = (
	messageId: string,
	playbackId: string,
	level: "full" | "partial" | "none",
	text = "できました。",
) =>
	h.store.write((db) =>
		h.dialogue.recordMessageHeardInTransaction(db, {
			messageId,
			playbackId,
			heard: level,
			text,
		}),
	);

test("storage, partial and failed speech leave the TODO; only full playback archives once", async () => {
	await fixture();
	await report();
	expect(h.todos()).toMatchObject([
		{ id: "todo", status: "done", reportPending: true },
	]);
	await heard("message", "cut", "partial");
	expect(h.todos()[0]?.reportPending).toBeUndefined();
	await heard("message", "failed", "none");
	expect(h.todos()).toHaveLength(1);
	// A contradictory duplicate of a partial acknowledgement cannot turn it into full.
	await heard("message", "cut", "full");
	expect(h.todos()).toHaveLength(1);
	await heard("message", "replayed", "full");
	await heard("message", "replayed", "full");
	expect(h.todos()).toEqual([]);
	expect(
		h.log().filter((event) => h.fields(event).action === "work.archived"),
	).toHaveLength(1);
});

test("unknown, stale text and user-message acknowledgements are rejected", async () => {
	await fixture();
	await report();
	expect(await heard("unknown", "a", "full")).toBe(false);
	expect(await heard("message", "b", "full", "違う本文")).toBe(false);
	await h.conversation.append({
		id: "user",
		runId: null,
		conversationId: "main",
		role: "user",
		text: "できました。",
		createdAt: new Date().toISOString(),
	});
	expect(await heard("user", "c", "full")).toBe(false);
	expect(h.todos()).toHaveLength(1);
});

test("a late old playback cannot archive a TODO associated with a newer report", async () => {
	await fixture();
	await report("old");
	await report("new");
	await heard("old", "late", "full");
	expect(h.todos()).toHaveLength(1);
	await heard("new", "current", "full");
	expect(h.todos()).toEqual([]);
});

test("a changed work revision invalidates the old report before its late playback finishes", async () => {
	await fixture();
	await report();
	await h.store.write((db) =>
		expect(
			updateWork(
				db,
				"todo",
				2,
				{ status: "done", result: { summary: "新しい結果" } },
				new Date().toISOString(),
			),
		).toBe(true),
	);
	await heard("message", "old-result", "full");
	expect(h.todos()).toHaveLength(1);
	expect(h.todos()[0]?.reportPending).toBeUndefined();
});

test("a full playback before reconciliation can confirm its report, but cannot replace a newer report", async () => {
	await fixture();
	h.state.steps.push({ text: "できました。" });
	const first = await h.say("結果は？");
	await heard(first.answerMessageId!, "first-speech", "full");
	expect(h.todos()).toHaveLength(1);
	await report("newer-report");
	await h.store.write((db) =>
		h.dialogue.archiveReportedInTransaction(db, {
			conversationId: "main",
			messageId: first.answerMessageId!,
			todoIds: ["todo"],
		}),
	);
	expect(h.todos()).toHaveLength(1);
	await heard("newer-report", "newer-speech", "full");
	expect(h.todos()).toEqual([]);
});
