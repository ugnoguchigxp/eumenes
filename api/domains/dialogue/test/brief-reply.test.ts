import { afterEach, expect, test } from "bun:test";
import { isBriefSpokenReply } from "../../delivery";
import { parseSpecialistAction } from "../service/specialist-prompt";
import { setup, type Harness } from "./generation.fixture";

/**
 * The brief spoken reply contract of the specialist's reply, and a display artifact's body, which is no speech.
 * The conversation agent's reply length is the agent's own style (no host repair, no failure for a long reply).
 */
let h: Harness | undefined;
afterEach(async () => {
	await h?.close();
	h = undefined;
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
	h.state.steps.push({ text: content });
	const run = await h.say("画面に表示する原稿を作って", "completed", {
		presentation: "artifact",
	});
	expect(run.status).toBe("completed");
	expect(h.dialogue.answerText(run.id)).toBe(content);
	expect(h.state.calls).toHaveLength(1);
});

test("a long conversation answer is adopted as it is: the host neither repairs nor rejects it", async () => {
	h = await setup();
	const verbose =
		"承知しました。説明します。まずはこちらです。最後に確認します。";
	h.state.steps.push({ text: verbose });
	const run = await h.say("説明して");
	expect(h.dialogue.answerText(run.id)).toBe(verbose);
	expect(h.state.calls).toHaveLength(1);
});
