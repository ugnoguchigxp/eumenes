import { afterEach, expect, test } from "bun:test";
import { publicSubmitSchema, resubmitSchema } from "../contracts";
import { setup, userOf, type Harness } from "./generation.fixture";

let h: Harness | undefined;
afterEach(async () => {
	await h?.close();
	h = undefined;
});

test("the conversation model reads the whole supported utterance before any search", async () => {
	h = await setup();
	h.state.steps.push({ text: "読みました。" });
	const words = "あ".repeat(1990) + "い".repeat(64);
	const run = await h.say(words);
	expect(h.dialogue.answerText(run.id)).toBe("読みました。");
	expect(h.state.calls.map(userOf)).toEqual([words]);
	expect(h.state.searchSlots).toEqual([]);
});

test("an input without words can receive a conversation reply without a search", async () => {
	h = await setup();
	h.state.steps.push({ text: "見ました。" });
	const run = await h.say("");
	expect(h.dialogue.answerText(run.id)).toBe("見ました。");
	expect(h.state.searchSlots).toEqual([]);
});

test("an utterance is accepted up to 4,000 characters, typed or corrected", () => {
	const base = {
		requestId: crypto.randomUUID(),
		conversationId: "main",
	};
	expect(
		publicSubmitSchema.safeParse({ ...base, text: "あ".repeat(4000) }).success,
	).toBe(true);
	expect(
		publicSubmitSchema.safeParse({ ...base, text: "あ".repeat(4001) }).success,
	).toBe(false);
	expect(
		resubmitSchema.safeParse({
			requestId: base.requestId,
			text: "あ".repeat(4001),
		}).success,
	).toBe(false);
});
