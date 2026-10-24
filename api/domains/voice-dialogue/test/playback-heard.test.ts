import { expect, test } from "bun:test";
import { createContinuityService } from "../../continuity";
import { say, setup, until, wav } from "./settings-voice.fixture";

/** How far a spoken answer reached the user is logged as its `delivered` event (the ContextWindow spec, 8.1). */
/** The `delivered` events the host logged for the main conversation, as the fields it wrote. */
function deliveredFields(h: Awaited<ReturnType<typeof setup>>) {
	return h.store
		.read((db) =>
			createContinuityService(h.store).events.logInTransaction(db, "main"),
		)
		.filter((event) => event.type === "delivered")
		.map((event) => JSON.parse(event.text ?? "{}") as Record<string, unknown>);
}

test("an answer played to its end is recorded as heard in full", async () => {
	const h = await setup(undefined, {
		transcribe: async () => "数えてください",
		answer: async () => "一、二、三。",
		speak: async () => wav(),
	});
	const id = crypto.randomUUID();
	h.voice.start("heard-full", 1);
	await say(h, "heard-full", id);
	await until(() => h.voice.get(id)?.status === "ready");
	const chunks = h.voice.get(id)!.audioChunks;
	expect(chunks).toHaveLength(3);
	for (const chunk of chunks) await h.voice.played(id, chunk.index);
	expect(h.voice.get(id)?.status).toBe("played");
	expect(deliveredFields(h)).toEqual([
		expect.objectContaining({ heard: "full" }),
	]);
	expect(deliveredFields(h)[0]).not.toHaveProperty("deliveredText");
});

test("an answer stopped after its first clause is recorded as heard in part, with the clause that reached the user", async () => {
	const h = await setup(undefined, {
		transcribe: async () => "数えてください",
		answer: async () => "一、二、三。",
		speak: async () => wav(),
	});
	const id = crypto.randomUUID();
	h.voice.start("heard-partial", 1);
	await say(h, "heard-partial", id);
	await until(() => h.voice.get(id)?.status === "ready");
	const [first] = h.voice.get(id)!.audioChunks;
	await h.voice.played(id, first!.index);
	await h.voice.cancel(id);
	expect(h.voice.get(id)?.status).toBe("cancelled");
	expect(deliveredFields(h)).toEqual([
		expect.objectContaining({ heard: "partial", deliveredText: "一、" }),
	]);
});
