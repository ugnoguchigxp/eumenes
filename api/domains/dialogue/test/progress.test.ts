import { afterEach, expect, test } from "bun:test";
import type { DialogueDeps } from "../service/context";
import { createProgress } from "../service/progress";
import { openDialogueStore, removeDialogueStore } from "./store.fixture";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) removeDialogueStore(dir);
});

test("publishing an unwatched run still delivers its current status to a later subscriber", async () => {
	const { dir, store } = openDialogueStore("eumenes-progress-");
	dirs.push(dir);
	await store.write((db) => {
		db.run(
			"INSERT INTO conversations (id, created_at) VALUES ('c', '2026-10-31T00:00:00.000Z')",
		);
		db.run(
			"INSERT INTO messages (id, conversation_id, role, text, created_at) VALUES ('m', 'c', 'user', 'hello', '2026-10-31T00:00:00.000Z')",
		);
		db.run(
			`INSERT INTO dialogue_runs (id, request_id, conversation_id, status, revision, input_message_id, created_at, updated_at)
			 VALUES ('r', 'req', 'c', 'running', 1, 'm', '2026-10-31T00:00:00.000Z', '2026-10-31T00:00:00.000Z')`,
		);
	});
	const progress = createProgress({
		store,
		conversation: { get: () => ({ messages: [] }) },
	} as unknown as DialogueDeps);
	progress.publish("r");
	const seen: string[] = [];
	const stop = progress.subscribeProgress("r", (value) => {
		seen.push(value.status);
	});
	expect(seen).toEqual(["running"]);
	stop();
	progress.close();
	await store.close();
});
