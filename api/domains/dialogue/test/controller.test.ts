import { afterEach, expect, test } from "bun:test";
import { Hono } from "hono";
import { submitSchema } from "../contracts";
import { registerDialogue } from "..";
import { setup, type Harness } from "./generation.fixture";

let h: Harness | undefined;
afterEach(async () => {
	await h?.close();
	h = undefined;
});

/** The HTTP surface over a dialogue with its queue held (no generation runs while these tests look). */
async function app() {
	h = await setup({ autoStart: false });
	const hono = new Hono();
	registerDialogue(hono, h.dialogue);
	return hono;
}

test("the dialogue controller validates requests and delegates one run per request ID", async () => {
	const hono = await app();
	const invalid = await hono.request("/api/runs", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ text: "" }),
	});
	expect(invalid.status).toBe(400);
	const input = {
		requestId: crypto.randomUUID(),
		conversationId: "main",
		text: "質問",
	};
	const first = await hono.request("/api/runs", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(input),
	});
	expect(first.status).toBe(202);
	const run = (await first.json()) as { id: string };
	const second = await hono.request("/api/runs", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(input),
	});
	expect(((await second.json()) as { id: string }).id).toBe(run.id);
	const found = await hono.request(`/api/runs/${run.id}`);
	expect(found.status).toBe(200);
	expect(h!.dialogue.list("main")).toHaveLength(1);
});

test("the public runs API rejects utteranceId, unknown keys and a pinned toolchain outside a form submit; it accepts the shape web and CLI send", async () => {
	const hono = await app();
	const post = (body: unknown) =>
		hono.request("/api/runs", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
	const base = {
		requestId: crypto.randomUUID(),
		conversationId: "main",
		text: "こんにちは",
	};
	expect((await post({ ...base, utteranceId: "voice-1" })).status).toBe(400);
	expect((await post({ ...base, extra: 1 })).status).toBe(400);
	// A pinned toolchain belongs to an artifact screen's form submit only.
	const pinned = { ...base, toolchainId: "image.create" };
	expect((await post(pinned)).status).toBe(400);
	expect((await post({ ...pinned, presentation: "conversation" })).status).toBe(
		400,
	);
	expect(
		(await post({ ...pinned, presentation: "artifact", toolchainId: "Bad Id" }))
			.status,
	).toBe(400);
	// A form submit carries no attachments: the specialist would get none of them.
	expect(
		(
			await post({
				...pinned,
				presentation: "artifact",
				attachmentIds: [crypto.randomUUID()],
			})
		).status,
	).toBe(400);
	expect(
		submitSchema.safeParse({
			...pinned,
			presentation: "artifact",
			utteranceId: "voice-1",
		}).success,
	).toBe(false);
	expect((await post(base)).status).toBe(202);
});

test("the resubmit route answers the new run, 400 for an empty text, 404 for an unknown message and 409 when refused", async () => {
	const hono = await app();
	const post = (messageId: string, body: unknown) =>
		hono.request(`/api/conversations/main/messages/${messageId}/resubmit`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
	const first = await h!.dialogue.submit({
		requestId: crypto.randomUUID(),
		conversationId: "main",
		text: "A",
	});
	await h!.dialogue.submit({
		requestId: crypto.randomUUID(),
		conversationId: "main",
		text: "B",
	});
	const latest = h!.dialogue.list("main").at(-1)!;
	const edited = await post(latest.inputMessageId, {
		requestId: crypto.randomUUID(),
		text: "C",
	});
	expect(edited.status).toBe(200);
	expect(
		((await edited.json()) as { run: { inputMessageId: string } }).run
			.inputMessageId,
	).toBe(latest.inputMessageId);
	const empty = await post(latest.inputMessageId, {
		requestId: crypto.randomUUID(),
		text: "  ",
	});
	expect([empty.status, await empty.json()]).toEqual([
		400,
		{ error: "empty_text" },
	]);
	const unknown = await post(crypto.randomUUID(), {
		requestId: crypto.randomUUID(),
		text: "D",
	});
	expect(unknown.status).toBe(404);
	const older = await post(first.inputMessageId, {
		requestId: crypto.randomUUID(),
		text: "D",
	});
	expect([older.status, await older.json()]).toEqual([
		409,
		{ error: "not_latest" },
	]);
	const invalid = await post(latest.inputMessageId, { text: "D" });
	expect(invalid.status).toBe(400);
});
