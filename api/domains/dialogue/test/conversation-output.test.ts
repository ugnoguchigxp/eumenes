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

test("an ASCII run attached to control syntax goes with it, even when it streamed first", () => {
	for (const [text, answer] of [
		['create_music{question:<|"|>夜の曲<|"|>}', ""],
		['作りますね。create_music{question:<|"|>夜の曲<|"|>}', "作りますね。"],
	] as const) {
		const visible: string[] = [];
		const output = conversationOutput((s) => visible.push(s), generationTools);
		for (const c of text) output.delta(c);
		expect(output.finish(text)).toBe(answer);
		expect(visible.join("")).toBe(answer);
	}
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

test("the toolchain titles the system lists may be said as they are; the rule around them is still checked", () => {
	const titles = ["音楽ライブラリの再生と管理", "イメージ画像の生成と編集"];
	const system = [
		"## Toolchains",
		`- 依頼できる担当: ${titles.join("、")}。何ができるかを聞かれたときに答えるための一覧で、一覧にあっても探します。`,
	].join("\n");
	const answer = `できることは、${titles.join("、")}です。`;
	expect(() =>
		conversationOutput(() => {}, generationTools, system, titles).finish(
			answer,
		),
	).not.toThrow();
	expect(() =>
		conversationOutput(() => {}, generationTools, system).finish(answer),
	).toThrow("system_text_copied");
	expect(() =>
		conversationOutput(() => {}, generationTools, system, titles).finish(
			"何ができるかを聞かれたときに答えるための一覧です。",
		),
	).toThrow("system_text_copied");
});

test("an answer that copies a line of the system part fails as it streams, and an ordinary answer passes", () => {
	const system = [
		"## Results",
		"- 曲・画像・図の生成の結果: 完成と名前を短く伝えます。再生や表示を尋ねてかまいません。",
	].join("\n");
	const published: string[] = [];
	const output = conversationOutput(
		(text) => published.push(text),
		generationTools,
		system,
	);
	output.delta("火曜の夜の音楽を生成します。");
	output.delta(": 完成と名前を短く");
	// Fifteen characters of a rule line as they are: the reply is not an answer.
	expect(() => output.delta("伝えます。再生や")).toThrow("system_text_copied");
	const ordinary = conversationOutput(() => {}, generationTools, system);
	ordinary.delta("元気が出る曲ができあがりました。再生しますか？");
	expect(
		ordinary.finish("元気が出る曲ができあがりました。再生しますか？"),
	).toBe("元気が出る曲ができあがりました。再生しますか？");
	// A reply that did not stream is checked whole.
	expect(() =>
		conversationOutput(() => {}, generationTools, system).finish(
			"はい。完成と名前を短く伝えます。再生や表示を尋ねてかまいません。",
		),
	).toThrow("system_text_copied");
});
