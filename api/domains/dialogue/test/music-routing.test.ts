import { expect, test } from "bun:test";
import { conversationTools, operation } from "../service/conversation-tools";
test("music can only be selected when its tool is offered", () => {
	const call = {
		id: "one",
		name: "create_music",
		arguments: JSON.stringify({ question: "Tetrisを30秒" }),
	};
	expect(() => operation([call], conversationTools(false))).toThrow();
	expect(
		operation([call], conversationTools(false, false, false, true)),
	).toEqual({ kind: "music", question: "Tetrisを30秒" });
});
