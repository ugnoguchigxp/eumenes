import { afterEach, expect, spyOn, test } from "bun:test";
import type { RunProgress } from "../contracts";
import type { DialogueDeps } from "../service/context";
import { createProgress } from "../service/progress";
import { openDialogueStore, removeDialogueStore } from "./store.fixture";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function setup() {
	const { dir, store } = openDialogueStore("eumenes-progress-stream-");
	await store.write((db) => {
		db.run("INSERT INTO conversations (id, created_at) VALUES ('c', 'now')");
		db.run(
			"INSERT INTO messages (id, conversation_id, role, text, created_at) VALUES ('m', 'c', 'user', 'hello', 'now')",
		);
		db.run(
			"INSERT INTO dialogue_runs (id, request_id, conversation_id, status, revision, input_message_id, created_at, updated_at) VALUES ('r', 'req', 'c', 'running', 1, 'm', 'now', 'now')",
		);
	});
	const saved = [{ id: "answer", text: "採用した回答。" }];
	const progress = createProgress({
		store,
		conversation: { get: () => ({ messages: saved }) },
	} as unknown as DialogueDeps);
	cleanups.push(async () => {
		progress.close();
		await store.close();
		removeDialogueStore(dir);
	});
	const seen: RunProgress[] = [];
	progress.subscribeProgress("r", (value) => seen.push(value));
	return { store, progress, seen };
}

test("progress exposes the live generation without reading or writing the database on each delta", async () => {
	const { store, progress, seen } = await setup();
	const send = progress.openAnswerStream(
		"r",
		"first",
		new AbortController().signal,
	);
	const read = spyOn(store, "read");
	const write = spyOn(store, "write");
	try {
		send("途中");
		send("途中の本文。");
		expect(read).not.toHaveBeenCalled();
		expect(write).not.toHaveBeenCalled();
		expect(seen.at(-1)).toMatchObject({
			status: "running",
			text: "途中の本文。",
			provisional: { generationId: "first", sequence: 2 },
		});
	} finally {
		read.mockRestore();
		write.mockRestore();
	}
	expect(
		store.read((db) =>
			db.query("SELECT id FROM messages WHERE role='assistant'").all(),
		),
	).toEqual([]);
	const reconnected: RunProgress[] = [];
	progress.subscribeProgress("r", (value) => reconnected.push(value));
	expect(reconnected[0]).toEqual(seen.at(-1));
});

test("aborting a generation clears current subscribers and cannot replay stale text after reconnect", async () => {
	const { progress, seen } = await setup();
	const controller = new AbortController();
	const send = progress.openAnswerStream("r", "first", controller.signal);
	send("破棄する本文。");
	controller.abort(new Error("permission_revoked"));
	expect(seen.at(-1)).toMatchObject({
		status: "running",
		text: "",
		provisional: null,
	});
	expect(() => send("遅い本文。")).toThrow("permission_revoked");
	const reconnected: RunProgress[] = [];
	progress.subscribeProgress("r", (value) => reconnected.push(value));
	expect(reconnected[0]?.text).toBe("");
});

test("a replacement generation starts empty and an old abort cannot clear its text", async () => {
	const { progress, seen } = await setup();
	const old = new AbortController();
	const sendOld = progress.openAnswerStream("r", "first", old.signal);
	sendOld("旧本文。");
	const send = progress.openAnswerStream(
		"r",
		"second",
		new AbortController().signal,
	);
	expect(seen.at(-1)).toMatchObject({
		text: "",
		provisional: { generationId: "second", sequence: 0 },
	});
	send("新本文。");
	old.abort();
	expect(() => sendOld("遅い旧本文。")).toThrow();
	expect(seen.at(-1)).toMatchObject({
		text: "新本文。",
		provisional: { generationId: "second", sequence: 1 },
	});
});

test.each(["cancelled", "failed"] as const)(
	"a committed %s run clears all partial text and rejects later deltas",
	async (status) => {
		const { store, progress, seen } = await setup();
		const send = progress.openAnswerStream(
			"r",
			"first",
			new AbortController().signal,
		);
		send("途中の本文。");
		await store.write((db) =>
			db.run(
				"UPDATE dialogue_runs SET status=?,revision=revision+1 WHERE id='r'",
				[status],
			),
		);
		expect(seen.at(-1)).toMatchObject({ status, text: "", provisional: null });
		expect(() => send("遅い本文。")).toThrow();
		expect(progress.progress("r")?.text).toBe("");
	},
);

test("adoption replaces partial text with the saved answer; deleting a watched run clears it", async () => {
	const { store, progress, seen } = await setup();
	progress.openAnswerStream(
		"r",
		"first",
		new AbortController().signal,
	)("未採用の本文。");
	const adoptionStart = seen.length;
	await store.write((db) => {
		db.run(
			"INSERT INTO messages (id, conversation_id, role, text, created_at) VALUES ('answer', 'c', 'assistant', '採用した回答。', 'now')",
		);
		db.run(
			"UPDATE dialogue_runs SET status='completed',answer_message_id='answer',revision=revision+1 WHERE id='r'",
		);
	});
	expect(seen.at(-1)).toMatchObject({
		status: "completed",
		text: "採用した回答。",
		provisional: null,
	});
	// Every notification during adoption must carry the saved answer, with no blank running frame.
	expect(seen.slice(adoptionStart).length).toBeGreaterThan(0);
	for (const value of seen.slice(adoptionStart))
		expect(value).toMatchObject({
			status: "completed",
			text: "採用した回答。",
			provisional: null,
		});
	await store.write((db) => db.run("DELETE FROM dialogue_runs WHERE id='r'"));
	expect(seen.at(-1)).toMatchObject({
		status: "cancelled",
		text: "",
		provisional: null,
	});
});
