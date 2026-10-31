import { afterEach, expect, test } from "bun:test";
import { reply, setup, type Harness } from "./generation.fixture";

/**
 * A reply that copies the system part (the tool-call reliability design, section 5.5): it fails as it streams and is
 * not kept, so the next turn has nothing of it to copy again.
 */
let h: Harness | undefined;

/** A reply that repeats a line of the talk turn's system part (its Facts rule), after words of its own. */
const COPIED =
	"曲を生成します。: 文章・ページ・画面・コードなどの制作物は、この返事では書きません。";

afterEach(async () => {
	await h?.close();
	h = undefined;
});

test("a reply copying the rules is not kept and the host answers in its words: the next turn does not see it", async () => {
	h = await setup();
	h.state.steps.push(...reply(COPIED), ...reply("どうぞ。"));
	const failed = await h.say("火曜の夜にぴったりの音楽を作って");
	// The copy stopped the talk call as it streamed: the user is told the host's words, never the copy.
	expect(h.dialogue.answerText(failed.id)).toBe(
		"うまく答えられませんでした。もう一度言ってもらえますか。",
	);
	await h.say("それで？");
	const all = h.state.calls
		.at(-1)!
		.messages.map((m) => m.content)
		.join("\n");
	expect(all).not.toContain("曲を生成します");
	expect(
		h.conversation
			.get("main")
			.messages.map((m) => m.text)
			.join("\n"),
	).not.toContain("曲を生成します");
});

test("a copying utterance kept before the gate (or the agency's) is not drawn into the recent conversation", async () => {
	h = await setup();
	h.state.steps.push(...reply("おはようございます。"), ...reply("どうぞ。"));
	await h.say("こんにちは");
	await h.store.write((db) =>
		h!.conversation.input.appendUtteranceInTransaction(db, {
			conversationId: "main",
			speaker: "agent",
			text: COPIED,
			messageId: "kept-before",
			at: new Date().toISOString(),
		}),
	);
	await h.say("おはよう");
	const all = h.state.calls
		.at(-1)!
		.messages.map((m) => m.content)
		.join("\n");
	expect(all).toContain("おはようございます。");
	expect(all).not.toContain("曲を生成します");
});
