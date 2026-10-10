import { expect, test } from "vitest";
import { renderSafeMarkdown } from "./markdownRenderer";

test("chat markdown keeps formatting while escaping raw HTML and unsafe links", () => {
	const html = renderSafeMarkdown(
		"## 回答\n**重要** と [参照](https://example.com)\n<script>alert(1)</script>\n[危険](javascript:alert(1))",
	);
	expect(html).toContain("<h2>回答</h2>");
	expect(html).toContain("<strong>重要</strong>");
	expect(html).toContain('href="https://example.com"');
	expect(html).not.toContain("<script>");
	expect(html).not.toContain('href="javascript:');
});

test.each(["- ", "* ", "+ ", "1. ", "1) "])(
	"an empty list marker %j terminates instead of freezing the conversation",
	(marker) => {
		const tag = /^\d/.test(marker) ? "ol" : "ul";
		expect(renderSafeMarkdown(marker)).toBe(`<${tag}><li></li></${tag}>`);
	},
);

test("an empty list entry does not hide the following answer or bypass escaping", () => {
	expect(renderSafeMarkdown("- 最初\n- \n- <script>次</script>\n\n続き")).toBe(
		"<ul><li>最初</li><li></li><li>&lt;script&gt;次&lt;/script&gt;</li></ul><p>続き</p>",
	);
});

test("link text that hides the destination host gets the hostname appended", () => {
	const hidden = renderSafeMarkdown("[公式サイト](https://phish.example/)");
	expect(hidden).toContain(
		'公式サイト<span class="link-host">(phish.example)</span></a>',
	);
	expect(
		renderSafeMarkdown("[https://a.example](https://a.example)"),
	).not.toContain("link-host");
});

test("a label that merely contains the host does not suppress host disclosure", () => {
	expect(renderSafeMarkdown("[Google.com](https://e.co/)")).toContain(
		'<span class="link-host">(e.co)</span>',
	);
	expect(
		renderSafeMarkdown("[example.com](https://example.com/path)"),
	).not.toContain("link-host");
	expect(
		renderSafeMarkdown("[www.example.com](https://example.com)"),
	).not.toContain("link-host");
});

test("urls with one level of parentheses stay intact", () => {
	const html = renderSafeMarkdown(
		"[Wiki](https://en.wikipedia.org/wiki/Foo_(bar))",
	);
	expect(html).toContain('href="https://en.wikipedia.org/wiki/Foo_(bar)"');
	expect(html).not.toContain("</a>)");
	expect(renderSafeMarkdown("[x](javascript:alert(1))")).not.toContain("<a ");
});

test("mermaid fences do not emit a duplicate hidden source", () => {
	const html = renderSafeMarkdown("```mermaid\ngraph TD;A-->B\n```");
	expect(html).toContain("mermaid-block");
	expect(html).not.toContain("mermaid-source");
});
