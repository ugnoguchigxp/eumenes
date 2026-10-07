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
