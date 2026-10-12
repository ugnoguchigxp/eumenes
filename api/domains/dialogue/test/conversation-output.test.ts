import { expect, test } from "bun:test";
import { conversationOutput } from "../service/conversation-output";
import { toolchainTools } from "../service/conversation-tools";

const leaked =
	'create_music{question:<|"|>夜にふさわしい、しっとりとした落ち着いた雰囲気の楽曲。2分間。<|"|>}';
for (const text of [
	leaked,
	'<call:research_web_luna{question:<|"|>最新ニュース<|"|>}>',
	'timer \n ({"operation":"start"})',
	'open_music_library{"question":"保存曲"}',
	'<call:unoffered{question:"secret"}>',
	"<|unknown_control|>",
])
	for (const chunkSize of [1, 3, text.length])
		test(`control text is never projected, including split delimiters: ${text.slice(0, 18)} / ${chunkSize}`, () => {
			const visible: string[] = [];
			const output = conversationOutput((s) => visible.push(s));
			for (let i = 0; i < text.length; i += chunkSize)
				output.delta(text.slice(i, i + chunkSize));
			expect(() => output.finish(text)).toThrow(
				"invalid_conversation_operation",
			);
			expect(visible).toEqual([]);
		});

test("offered function names are checked without adding a scenario or name-specific rule", () => {
	const tools = toolchainTools([
		{
			revisionId: "toolchain:custom@1",
			id: "custom",
			functionName: "another_action",
			title: "custom",
			summary: "custom",
			useWhen: ["custom"],
			redirects: [],
			score: { rank: 1, ftsRank: null, similarity: null, fromHistory: false },
		},
	]);
	const visible: string[] = [];
	const output = conversationOutput((s) => visible.push(s), tools);
	for (const c of 'another_action {"value":"x"}') output.delta(c);
	expect(() => output.finish('another_action {"value":"x"}')).toThrow();
	expect(visible).toEqual([]);
});

test("ordinary prose, JSON, code and name mentions retain their text and stream before completion", () => {
	const visible: string[] = [];
	const output = conversationOutput((s) => visible.push(s));
	const text =
		'回答です。research は調査機能です。例: {"answer":42}。const x = Math.max(1, 2); 1 < 2。';
	for (const c of text) output.delta(c);
	expect(visible.join("")).toBe(text);
	output.finish(text);
	expect(visible.join("")).toBe(text);
});

test("an unfinished function name is held until its ordinary continuation is known", () => {
	const visible: string[] = [];
	const output = conversationOutput((s) => visible.push(s));
	output.delta("create_mu");
	expect(visible).toEqual([]);
	output.delta("sic の意味です。");
	output.finish("create_music の意味です。");
	expect(visible.join("")).toBe("create_music の意味です。");
});

test("a bare name at end of an answer is released after completion", () => {
	const visible: string[] = [];
	const output = conversationOutput((s) => visible.push(s));
	output.delta("research");
	expect(visible).toEqual([]);
	output.finish("research");
	expect(visible).toEqual(["research"]);
});

test("a natural prefix does not allow subsequent control syntax into the projection", () => {
	const visible: string[] = [];
	const output = conversationOutput((s) => visible.push(s));
	output.delta("確認します。");
	for (const c of leaked) output.delta(c);
	expect(() => output.finish("確認します。" + leaked)).toThrow();
	expect(visible.join("")).toBe("確認します。");
});

test("control text in a nonstream response is also rejected", () => {
	const output = conversationOutput(() => {
		throw new Error("must_not_publish");
	});
	expect(() => output.finish(leaked)).toThrow("invalid_conversation_operation");
});

test("held whitespace and discarded output still obey the total capacity limit", () => {
	const output = conversationOutput(() => {});
	output.delta("research" + " ".repeat(65528));
	expect(() => output.delta(" ")).toThrow("chat_output_too_large");
	const blocked = conversationOutput(() => {});
	blocked.delta("<|");
	expect(() => blocked.delta("x".repeat(65535))).toThrow(
		"chat_output_too_large",
	);
});
