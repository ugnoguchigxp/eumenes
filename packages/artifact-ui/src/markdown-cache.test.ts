import { expect, test } from "bun:test";
import { markdownCacheFile } from "./markdown-cache";
test("scratch cache contains exact Markdown, Plate styling and imported original as one ordinary JSON file", async () => {
	const markdown = "\uFEFF# 日本語\r\n末尾  \r\n",
		draft = {
			documentId: "local",
			baseRevision: 4,
			title: "cacheの文書",
			document: {
				formatVersion: 1 as const,
				nodes: [
					{
						type: "p",
						align: "center",
						children: [{ text: "日本語", bold: true, color: "#123456" }],
					},
				],
				originalMarkdown: markdown,
			},
		};
	const file = markdownCacheFile(draft, markdown),
		saved = JSON.parse(await file.text());
	expect(file.type.split(";")[0]).toBe("application/json");
	expect(file.name).toBe("cacheの文書.json");
	expect(saved).toEqual({ kind: "eumenes.markdown-cache", ...draft, markdown });
	expect(
		markdownCacheFile({ ...draft, title: "あ".repeat(300) }, markdown).name
			.length,
	).toBeLessThan(120);
});
