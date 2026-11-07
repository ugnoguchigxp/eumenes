import type { MarkdownDraft } from "@eumenes/design-system/markdown";

/** An ordinary scratch JSON file, with both readable Markdown and the lossless editor state. */
export function markdownCacheFile(
	draft: MarkdownDraft,
	markdown: string,
): File {
	const name = [...(draft.title || "無題")].slice(0, 110).join("") + ".json";
	return new File(
		[JSON.stringify({ kind: "eumenes.markdown-cache", ...draft, markdown })],
		name,
		{ type: "application/json" },
	);
}
