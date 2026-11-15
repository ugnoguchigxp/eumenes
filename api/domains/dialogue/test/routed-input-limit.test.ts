import { afterEach, expect, test } from "bun:test";
import { publicSubmitSchema, resubmitSchema } from "../contracts";
import { startRouter, traceOf, weigh } from "./router.fixture";
import type { Harness } from "./generation.fixture";

let h: Harness | undefined;
afterEach(async () => {
	await h?.close();
	h = undefined;
});

test("the router reads the first 2,000 characters of a longer utterance and still routes it", async () => {
	const r = await startRouter();
	h = r.h;
	r.scripts.push(weigh({}));
	h.state.steps.push({ text: "読みました。" });
	const words = `${"あ".repeat(1990)}${"い".repeat(64)}`;
	const run = await h.say(words);
	expect(h.dialogue.answerText(run.id)).toBe("読みました。");
	expect(r.routes.map((route) => route.text)).toEqual([words.slice(0, 2000)]);
	expect(traceOf(h).error).toBeNull();
	expect(traceOf(h)).toMatchObject({ decided: "conversation.respond", row: 1 });
});

test("an utterance with no words asks the router nothing and is talked to", async () => {
	const r = await startRouter();
	h = r.h;
	h.state.steps.push({ text: "見ました。" });
	const run = await h.say("");
	expect(h.dialogue.answerText(run.id)).toBe("見ました。");
	expect(r.routes).toEqual([]);
	expect(r.structureCalls).toEqual([]);
	expect(traceOf(h).error).toBeNull();
	expect(traceOf(h)).toMatchObject({ decided: "conversation.respond", row: 1 });
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
