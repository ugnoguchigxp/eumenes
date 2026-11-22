import { afterEach, expect, test } from "bun:test";
import sharp from "sharp";
import { waitFor } from "../../../infrastructure/wait-for";
import { reply, setup, type Harness } from "./generation.fixture";

/**
 * The image rules (`dialogue.contexts.system.image-history`) are in the system part only for a conversation that has
 * an image in its record, and stay there once one has come, so the cached prefix changes once and not with each turn.
 */
let h: Harness | undefined;
afterEach(async () => {
	await h?.close();
	h = undefined;
});

const IMAGE_RULES = "画像を読んで答えるときは";
const systemOf = (call: NonNullable<Harness["state"]["calls"][number]>) =>
	call.messages.find((m) => m.role === "system")!.content;

test("a conversation without an image has no image rules, and once an image has come they stay", async () => {
	h = await setup();
	h.state.steps.push(...reply("はい。"));
	await h.say("おはよう");
	expect(systemOf(h.state.calls.at(-1)!)).not.toContain(IMAGE_RULES);

	const image = await h.conversation.uploadAttachment(
		"main",
		crypto.randomUUID(),
		new File(
			[
				await sharp({
					create: { width: 2, height: 2, channels: 3, background: "red" },
				})
					.png()
					.toBuffer(),
			],
			"first.png",
			{ type: "image/png" },
		),
	);
	h.state.steps.push(...reply("赤い画像です。"));
	const accepted = await h.dialogue.submit({
		requestId: crypto.randomUUID(),
		conversationId: "main",
		text: "何色ですか",
		attachmentIds: [image.id],
	});
	await waitFor(() => h!.dialogue.get(accepted.id)?.status === "completed");
	expect(systemOf(h.state.calls.at(-1)!)).toContain(IMAGE_RULES);

	h.state.steps.push(...reply("はい。"));
	await h.say("ありがとう");
	expect(systemOf(h.state.calls.at(-1)!)).toContain(IMAGE_RULES);
});
