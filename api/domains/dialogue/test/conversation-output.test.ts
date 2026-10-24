import { expect, test } from "bun:test";
import { conversationOutput } from "../service/conversation-output";
import { generationTools } from "../service/generation-tools";

/**
 * The text the model writes is checked for control syntax only: provider delimiters and a call written as text
 * (an offered tool's name followed by its arguments) are never published, whether streamed or not (section 6.3).
 */
const leaked =
	'delegate{mode:<|"|>execute<|"|>,toolchain:<|"|>fake.image<|"|>}';
for (const text of [
	leaked,
	'<call:work{todo:"x"}>',
	'respond ({"kind":"chat"})',
	'work\n({"operation":"check"})',
	"<|unknown_control|>",
])
	for (const chunkSize of [1, 3, text.length])
		test(`control text is never published, including split delimiters: ${text.slice(0, 18)} / ${chunkSize}`, () => {
			const visible: string[] = [];
			const output = conversationOutput(
				(s) => visible.push(s),
				generationTools,
			);
			for (let i = 0; i < text.length; i += chunkSize)
				output.delta(text.slice(i, i + chunkSize));
			expect(() => output.finish(text)).toThrow("control_text_in_body");
			expect(visible.join("")).not.toContain("<|");
			expect(visible.join("")).not.toContain("<call:");
		});

test("a name that is not an offered tool is ordinary text, and is published", () => {
	const visible: string[] = [];
	const output = conversationOutput((s) => visible.push(s), generationTools);
	const text = 'create_music {"question":"夜の曲"}';
	for (const c of text) output.delta(c);
	output.finish(text);
	expect(visible.join("")).toBe(text);
});

test("ordinary prose, JSON, code and tool-name mentions retain their text and stream before completion", () => {
	const visible: string[] = [];
	const output = conversationOutput((s) => visible.push(s), generationTools);
	const text =
		'回答です。work は調査機能です。例: {"answer":42}。const x = Math.max(1, 2); 1 < 2。';
	for (const c of text) output.delta(c);
	expect(visible.join("")).toBe(text);
	output.finish(text);
	expect(visible.join("")).toBe(text);
});

test("an unfinished tool name is held until its ordinary continuation is known", () => {
	const visible: string[] = [];
	const output = conversationOutput((s) => visible.push(s), generationTools);
	output.delta("deleg");
	expect(visible).toEqual([]);
	output.delta("ation の意味です。");
	output.finish("delegation の意味です。");
	expect(visible.join("")).toBe("delegation の意味です。");
});

test("a bare tool name at the end of an answer is released after completion", () => {
	const visible: string[] = [];
	const output = conversationOutput((s) => visible.push(s), generationTools);
	output.delta("respond");
	expect(visible).toEqual([]);
	output.finish("respond");
	expect(visible).toEqual(["respond"]);
});

test("the tool-search prose cannot substitute a bare tool name for a native call", () => {
	const output = conversationOutput(() => {}, generationTools);
	output.delta("find_toolchain\n準備します。");
	expect(() => output.finish("find_toolchain\n準備します。")).not.toThrow();
	const call = conversationOutput(() => {}, generationTools);
	call.delta('find_toolchain({"query":"絵"})');
	expect(() => call.finish('find_toolchain({"query":"絵"})')).toThrow(
		"control_text_in_body",
	);
});

test("a natural prefix does not let later control syntax into the published text", () => {
	const visible: string[] = [];
	const output = conversationOutput((s) => visible.push(s), generationTools);
	output.delta("確認します。");
	for (const c of leaked) output.delta(c);
	expect(() => output.finish("確認します。" + leaked)).toThrow(
		"control_text_in_body",
	);
	expect(visible.join("")).toBe("確認します。");
});

test("control text in a nonstream response is rejected and never published", () => {
	const output = conversationOutput(() => {
		throw new Error("must_not_publish");
	}, generationTools);
	expect(() => output.finish(leaked)).toThrow("control_text_in_body");
});

test("held whitespace and discarded output still obey the total capacity limit", () => {
	const output = conversationOutput(() => {}, generationTools);
	output.delta("respond" + " ".repeat(65529));
	expect(() => output.delta(" ")).toThrow("chat_output_too_large");
	const blocked = conversationOutput(() => {}, generationTools);
	blocked.delta("<|");
	expect(() => blocked.delta("x".repeat(65535))).toThrow(
		"chat_output_too_large",
	);
});

test("a tool name followed by a parenthesis in prose is not a call", () => {
	const visible: string[] = [];
	const output = conversationOutput((s) => visible.push(s), generationTools);
	const text = "memory (記憶) と work (仕事) の話です。";
	for (const c of text) output.delta(c);
	output.finish(text);
	expect(visible.join("")).toBe(text);
});
