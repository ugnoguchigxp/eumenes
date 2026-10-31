import { afterEach, expect, test } from "bun:test";
import type { DialogueDeps } from "../service/context";
import { deferFlush, flushDeferred } from "../service/specialist-core";
import { openDialogueStore, removeDialogueStore } from "./store.fixture";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) removeDialogueStore(dir);
});

test("a deferred flush does not cancel a run the database still has running", async () => {
	const { dir, store } = openDialogueStore("eumenes-flush-");
	dirs.push(dir);
	await store.write((db) => {
		db.run(
			"INSERT INTO conversations (id, created_at) VALUES ('c', '2026-10-31T00:00:00.000Z')",
		);
		db.run(
			"INSERT INTO messages (id, conversation_id, role, text, created_at) VALUES ('m', 'c', 'user', 'hello', '2026-10-31T00:00:00.000Z')",
		);
		for (const [id, status, seq] of [
			["live", "running", 1],
			["done", "cancelled", 2],
		] as const)
			db.run(
				`INSERT INTO dialogue_runs (id, request_id, conversation_id, status, revision, input_message_id, seq, created_at, updated_at)
				 VALUES (?, ?, 'c', ?, 1, 'm', ?, '2026-10-31T00:00:00.000Z', '2026-10-31T00:00:00.000Z')`,
				[id, `req-${id}`, status, seq],
			);
	});
	const cancelled: string[] = [];
	const deps = {
		store,
		larm: {
			cancelSubject: (runId: string) => {
				cancelled.push(runId);
				return Promise.resolve();
			},
		},
	} as unknown as DialogueDeps;
	deferFlush(deps, { flush: [], runs: ["live"] });
	flushDeferred(deps);
	expect(cancelled).toEqual([]);
	deferFlush(deps, { flush: [], runs: ["done"] });
	flushDeferred(deps);
	expect(cancelled).toEqual(["done"]);
	await store.close();
});
