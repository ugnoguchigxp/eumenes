import { afterEach, expect, test } from "bun:test";
import { setup, type Harness } from "./generation.fixture";

/**
 * A reply that copies the system part (the tool-call reliability design, section 5.5): it fails as it streams and is
 * not kept, so the next turn has nothing of it to copy again.
 */
let h: Harness | undefined;
afterEach(async () => {
	await h?.close();
	h = undefined;
});

test("a reply copying the rules fails its run and is not kept: the next turn does not see it", async () => {
	h = await setup();
	h.state.steps.push(
		{
			text: "曲を生成します。: 完成と名前を短く伝えます。再生や表示を尋ねてかまいません。",
		},
		{ text: "どうぞ。" },
	);
	const failed = await h.say("火曜の夜にぴったりの音楽を作って", "failed");
	expect(failed.error).toBe("system_text_copied");
	await h.say("それで？");
	const all = h.state.calls
		.at(-1)!
		.messages.map((m) => m.content)
		.join("\n");
	expect(all).not.toContain("曲を生成します");
});
