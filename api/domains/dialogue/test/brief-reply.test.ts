import { afterEach, expect, test } from "bun:test";
import { isBriefSpokenReply } from "../../delivery";
import { parseSpecialistAction } from "../service/specialist-prompt";
import { respond, setup, type Harness } from "./generation.fixture";

/**
 * The spoken reply contract of a conversation answer (the ContextWindow specification, section 6.4): a brief
 * reply is one or two sentences within the speech limit; a longer one is rewritten once by the structural repair.
 */
let h: Harness | undefined;
afterEach(async () => {
	await h?.close();
	h = undefined;
});

const chat = respond();
const verbose =
	"承知しました。説明します。まずはこちらです。最後に確認します。";

test("a verbose conversation answer is rewritten once by the repair, and the brief one is adopted", async () => {
	h = await setup();
	h.state.steps.push(
		{ text: verbose, calls: [chat] },
		{ text: "承知しました。", calls: [chat] },
	);
	const run = await h.say("説明して");
	expect(h.dialogue.answerText(run.id)).toBe("承知しました。");
	expect(h.state.calls).toHaveLength(2);
	const repaired = h.state.calls[1]!.messages.find((m) =>
		m.content.startsWith("UNTRUSTED_REJECTED_OUTPUT="),
	);
	expect(repaired?.content).toContain("spoken_reply_too_long");
});

test("two verbose answers fail the run without releasing any text", async () => {
	h = await setup();
	h.state.steps.push(
		{ text: verbose, calls: [chat] },
		{ text: verbose, calls: [chat] },
	);
	const run = await h.say("説明して", "failed");
	expect(run.error).toBe("invalid_conversation_operation");
	expect(h.dialogue.answerText(run.id)).toBeNull();
	expect(h.conversation.get("main").messages.map((m) => m.role)).toEqual([
		"user",
	]);
});

test("a link's address is display only and does not count toward the speech allowance", async () => {
	h = await setup();
	const answer = `雨の可能性は低い予報です。[予報](https://weather.example.com/${"path/".repeat(40)})`;
	h.state.steps.push({ text: answer, calls: [chat] });
	const run = await h.say("提示した予報を要約して");
	expect(run.status).toBe("completed");
	expect(h.state.calls).toHaveLength(1);
	expect(h.dialogue.answerText(run.id)).toBe(answer);
});

test("specialist reply length is bounded without limiting production arguments", () => {
	const content = "成果物の本文。".repeat(200);
	expect(parseSpecialistAction({ action: "reply", text: content })).toBeNull();
	expect(
		parseSpecialistAction({ action: "reply", text: "作成しました。" }),
	).toEqual({ kind: "reply", text: "作成しました。" });
	expect(
		parseSpecialistAction({
			action: "invoke",
			tool: "draft.apply",
			arguments: { content },
		}),
	).toMatchObject({ kind: "invoke", arguments: { content } });
});

test("brief speech is at most two sentences, keeping decimal values and links intact", () => {
	for (const text of [
		"一文です。",
		"確認しました。気温は25.5度です。",
		"完了しました。[結果](https://example.com/result)",
	])
		expect(isBriefSpokenReply(text)).toBe(true);
	expect(
		isBriefSpokenReply("承知しました。説明します。まずはこちらです。"),
	).toBe(false);
	expect(
		parseSpecialistAction({ action: "reply", text: "一。二。三。" }),
	).toBeNull();
});

test("a display artifact's body is not held to the speech contract", async () => {
	h = await setup();
	const content = "成果物の本文。".repeat(200);
	h.state.steps.push({ text: content, calls: [chat] });
	const run = await h.say("画面に表示する原稿を作って", "completed", {
		presentation: "artifact",
	});
	expect(run.status).toBe("completed");
	expect(h.dialogue.answerText(run.id)).toBe(content);
	expect(h.state.calls).toHaveLength(1);
});
