import { expect, test } from "bun:test";
import { messageReplyInput, sendMessageInput } from "../contracts/messaging";
test("UTF-8 byte limits and a complete successful summary are required", () => {
	const request = { requestId: crypto.randomUUID(), text: "あ".repeat(10922) };
	expect(sendMessageInput.safeParse(request).success).toBe(true);
	expect(
		sendMessageInput.safeParse({ ...request, text: request.text + "あ" })
			.success,
	).toBe(false);
	const reply = {
		replyId: crypto.randomUUID(),
		commandId: "command",
		messageId: "message",
		leaseId: crypto.randomUUID(),
		epoch: 1,
		outcome: "answered",
		replyText: "返答",
		summary: null,
		coveredMessageIds: [],
		limitations: [],
	};
	expect(messageReplyInput.safeParse(reply).success).toBe(false);
	expect(
		messageReplyInput.safeParse({ ...reply, summary: "あ".repeat(1366) })
			.success,
	).toBe(false);
	expect(
		messageReplyInput.safeParse({ ...reply, summary: "要約" }).success,
	).toBe(true);
	expect(
		messageReplyInput.safeParse({ ...reply, outcome: "failed" }).success,
	).toBe(true);
});
