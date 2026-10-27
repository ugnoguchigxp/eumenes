import { expect, test } from "bun:test";
import { Hono } from "hono";
import { registerVoiceDialogue } from "..";
import { setup } from "./settings-voice.fixture";

test("replay played API records real message playback and rejects malformed or stale acknowledgements", async () => {
	const h = await setup(undefined, {});
	await h.store.write((db) => {
		h.conversation.appendInTransaction(db, {
			id: "report",
			conversationId: "main",
			role: "assistant",
			text: "報告です。",
			runId: null,
			createdAt: new Date().toISOString(),
		});
		h.dialogue.recordSpontaneousInTransaction(db, {
			conversationId: "main",
			messageId: "report",
			text: "報告です。",
			at: new Date().toISOString(),
		});
	});
	const app = new Hono();
	registerVoiceDialogue(app, h.voice);
	const send = (body: unknown) =>
		app.request("/api/voice/replay/played", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
	const body = {
		messageId: "report",
		playbackId: crypto.randomUUID(),
		text: "報告です。",
		heard: "full",
	};
	expect((await send({ ...body, playbackId: "invalid" })).status).toBe(400);
	expect((await send({ ...body, text: "別の発話" })).status).toBe(400);
	expect((await send({ ...body, heard: "invalid" })).status).toBe(400);
	for (let n = 0; n < 2; n++) {
		const response = await send(body);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ recorded: true });
	}
});
