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
	'memory ({"operation":"request"})',
	'work\n({"operation":"check"})',
	"<|unknown_control|>",
	"t2を確認します。\n\n<tool_call>\n<function=state>\n<parameter=operation>\nread\n</parameter>\n</function>\n</tool_call>",
	"<function=work>\n<parameter=todo>\nt2\n</parameter>\n</function>",
	'表示されていますよ。\n\n<delegate>\n<parameter name="mode">execute</parameter>\n</delegate>',
	"<work>t3</work>",
	// The full-width form the log draws, copied back by the model (run `6c08b000`).
	'元気の出る曲、再生しますね。\n\n＜delegate＞\n＜parameter name="mode"＞execute＜/parameter＞\n＜/delegate＞',
	"＜tool_call＞\n＜function=work＞\n＜/function＞\n＜/tool_call＞",
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
			// The answer ends before the control syntax: it is what was published.
			expect(output.finish(text)).toBe(visible.join(""));
			expect(visible.join("")).not.toContain("<|");
			expect(visible.join("")).not.toContain("<call:");
			expect(visible.join("")).not.toContain("<tool_call>");
			expect(visible.join("")).not.toContain("<function=");
			expect(visible.join("")).not.toContain("<delegate");
			expect(visible.join("")).not.toContain("<work");
			expect(visible.join("")).not.toContain("<parameter");
			expect(visible.join("")).not.toContain("＜delegate");
			expect(visible.join("")).not.toContain("＜tool_call");
			expect(visible.join("")).not.toContain("＜function");
			expect(visible.join("")).not.toContain("＜parameter");
		});

test("a name that is not an offered tool is ordinary text, and is published", () => {
	const visible: string[] = [];
	const output = conversationOutput((s) => visible.push(s), generationTools);
	const text = 'create_music {"question":"夜の曲"}';
	for (const c of text) output.delta(c);
	output.finish(text);
	expect(visible.join("")).toBe(text);
});

test("angle brackets in ordinary prose are published", () => {
	const visible: string[] = [];
	const output = conversationOutput((s) => visible.push(s), generationTools);
	const text = "1 <2 と <b> と <memory_note と ＜注＞ は普通の文です。";
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
	output.delta("memory");
	expect(visible).toEqual([]);
	output.finish("memory");
	expect(visible).toEqual(["memory"]);
});

test("the tool-search prose cannot substitute a bare tool name for a native call", () => {
	const output = conversationOutput(() => {}, generationTools);
	output.delta("find_toolchain\n準備します。");
	expect(() => output.finish("find_toolchain\n準備します。")).not.toThrow();
	const call = conversationOutput(() => {}, generationTools);
	call.delta('find_toolchain({"query":"絵"})');
	expect(call.finish('find_toolchain({"query":"絵"})')).toBe("");
});

test("a natural prefix does not let later control syntax into the published text", () => {
	const visible: string[] = [];
	const output = conversationOutput((s) => visible.push(s), generationTools);
	output.delta("確認します。");
	for (const c of leaked) output.delta(c);
	expect(output.finish("確認します。" + leaked)).toBe("確認します。");
	expect(visible.join("")).toBe("確認します。");
});

test("control text in a nonstream response is never published; the text before it is the answer", () => {
	const output = conversationOutput(() => {
		throw new Error("must_not_publish");
	}, generationTools);
	expect(output.finish(leaked)).toBe("");
	const visible: string[] = [];
	const spoken = conversationOutput((s) => visible.push(s), generationTools);
	const text =
		'再生しますね。\n\n＜delegate＞\n＜parameter name="mode"＞execute＜/parameter＞';
	expect(spoken.finish(text)).toBe("再生しますね。");
	expect(visible.join("")).toBe("再生しますね。");
});

test("held whitespace and discarded output still obey the total capacity limit", () => {
	const output = conversationOutput(() => {}, generationTools);
	output.delta("memory" + " ".repeat(65530));
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
