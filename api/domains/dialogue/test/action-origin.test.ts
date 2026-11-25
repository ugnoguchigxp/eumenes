import { afterEach, expect, test } from "bun:test";
import {
	commandInputMessageIdsInTransaction,
	readActionOriginInTransaction,
} from "../service/action-origin";
import { reply, setup, type Harness } from "./generation.fixture";

let h: Harness | undefined;
afterEach(async () => {
	await h?.close();
	h = undefined;
});

test("a run's own input message is what an asynchronous execution checks its origin against", async () => {
	h = await setup();
	h.state.steps.push(...reply("はい。"));
	const run = await h.say("色は青です");
	const ids = h.store.read((db) =>
		commandInputMessageIdsInTransaction(db, run.id),
	);
	expect(ids).toEqual([run.inputMessageId]);
	expect(
		h.store.read((db) => commandInputMessageIdsInTransaction(db, "absent")),
	).toEqual([]);
});

test("only a live, saved human input can authorize a local action", async () => {
	h = await setup({ autoStart: false });
	const run = await h.dialogue.submit({
		requestId: crypto.randomUUID(),
		conversationId: "main",
		text: "開いて",
	});
	expect(
		h.store.read((db) => readActionOriginInTransaction(db, run.id)),
	).toMatchObject({
		conversationId: "main",
		messageId: run.inputMessageId,
		runId: run.id,
	});
	expect(
		h.store.read((db) => readActionOriginInTransaction(db, "absent")),
	).toBeNull();
});
