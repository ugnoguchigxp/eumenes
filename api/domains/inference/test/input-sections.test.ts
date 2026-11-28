import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	decodeSections,
	encodeSections,
	inputSections,
	tailSections,
} from "../service/input-sections";

const tool = {
	type: "function",
	function: { name: "find_toolchain", description: "d", parameters: {} },
};

test("sections name each message by a known heading or tag, else by a fixed word", () => {
	const sections = inputSections({
		messages: [
			{ role: "system", content: "あなたは執事です。長い指示。" },
			{ role: "user", content: "## Memory\n- 猫が好き" },
			{ role: "user", content: "## State\n今: 10-31" },
			{ role: "user", content: "<あなたの今の状態>\n秘密のメモ" },
			{
				role: "user",
				content: "## これは見出しではなく長い文章になっている一行です、本当に",
			},
			{ role: "user", content: "こんにちは" },
			{
				role: "assistant",
				content: "",
				tool_calls: [
					{
						id: "1",
						type: "function",
						function: { name: "a", arguments: "{}" },
					},
				],
			},
			{ role: "tool", content: "結果", tool_call_id: "1" },
		],
	});
	expect(sections.map((s) => [s.role, s.label])).toEqual([
		["system", "system"],
		["user", "Memory"],
		["user", "State"],
		["user", "agency-state"],
		["user", "text"],
		["user", "text"],
		["assistant", "tool-calls"],
		["tool", "tool-result"],
	]);
	for (const s of sections) {
		expect(s.hash).toMatch(/^[0-9a-f]{12}$/);
		expect(s.tokens).toBeGreaterThan(0);
	}
});

test("tools and the output schema come first and the encoded field carries no text", () => {
	const messages = [
		{ role: "system" as const, content: "秘密の指示" },
		{ role: "user" as const, content: "## User\n秘密の発話" },
	];
	const sections = inputSections({
		messages,
		tools: [tool],
		outputSchema: { type: "object" },
	});
	expect(sections.map((s) => s.label)).toEqual([
		"tools",
		"schema",
		"system",
		"User",
	]);
	const encoded = encodeSections(sections);
	expect(encoded).not.toContain("秘密");
	expect(encoded.split("|")).toHaveLength(4);
	expect(decodeSections(`${encoded}|…+3`)).toEqual(sections);
	expect(inputSections({ messages }).map((s) => s.label)).toEqual([
		"system",
		"User",
	]);
});

test("the hash follows the text and the label does not", () => {
	const of = (content: string) =>
		inputSections({ messages: [{ role: "user", content }] })[0]!;
	const a = of("## Memory\nA");
	const b = of("## Memory\nB");
	expect(a.label).toBe(b.label);
	expect(a.hash).not.toBe(b.hash);
	expect(of("## Memory\nA").hash).toBe(a.hash);
});

test("a heading that the product does not write is never a label, whoever wrote it", () => {
	const secret = "## 秘密の話題";
	const sections = inputSections({
		messages: [
			{ role: "system", content: `${secret}\n指示` },
			{ role: "user", content: `${secret}\n発話` },
			{ role: "user", content: "## Secret\nsecret" },
			{ role: "user", content: "## memory\n小文字" },
			{ role: "user", content: "## Memory extra\n続き" },
			{ role: "tool", content: `${secret}\n結果`, tool_call_id: "1" },
			{ role: "assistant", content: `${secret}\n返事` },
		],
	});
	expect(sections.map((s) => s.label)).toEqual([
		"system",
		"text",
		"text",
		"text",
		"text",
		"tool-result",
		"text",
	]);
	expect(encodeSections(sections)).not.toMatch(/秘密|Secret|secret|memory/);
});

test("the hash is keyed: it is not the plain digest of a short text", () => {
	const content = "はい";
	const [section] = inputSections({ messages: [{ role: "user", content }] });
	const plain = (text: string) =>
		createHash("sha256").update(text).digest("hex").slice(0, 12);
	for (const guess of [content, JSON.stringify([content, null, null, 0])])
		expect(section!.hash).not.toBe(plain(guess));
});

test("the last message is told by its sections, the fields of State and the keys of the agency's state; never by text", () => {
	const secret = "鎌倉の秘密の予定";
	const tail = tailSections([
		{ role: "system", content: "指示" },
		{
			role: "user",
			content: [
				"## Agency",
				`<あなたの今の状態 label="資料">${JSON.stringify({ notes: [{ id: "n1", title: secret }], quiet: {}, 利用者の名前: 1 })}</あなたの今の状態>`,
				"",
				"## State",
				"今: 11-28（土）22:00",
				"仕事:",
				`- ${secret}`,
				"提示中:",
				"- a1「地図」",
				`${secret}: これは見出しではない`,
				"",
				"## User",
				secret,
			].join("\n"),
		},
	]);
	expect(tail.map((part) => `${part.role}:${part.label}`)).toEqual([
		"part:Agency.notes",
		"part:Agency.quiet",
		"part:Agency.other",
		"part:State.now",
		"part:State.work",
		"part:State.presented",
		"part:User",
	]);
	expect(tail.every((part) => part.tokens > 0)).toBe(true);
	expect(encodeSections(tail)).not.toContain("鎌倉");
	// A message that is not the user's last, or has none of the product's headings, has no parts.
	expect(tailSections([{ role: "user", content: secret }])).toEqual([]);
	expect(
		tailSections([{ role: "assistant", content: "## State\n今: x" }]),
	).toEqual([]);
});
