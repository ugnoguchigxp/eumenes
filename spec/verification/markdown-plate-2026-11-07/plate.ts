import { createPlateEditor } from "platejs/react";
import { BasicBlocksPlugin, BasicMarksPlugin } from "@platejs/basic-nodes/react";
import { ListPlugin as ClassicListPlugin } from "@platejs/list-classic/react";
import { ListPlugin } from "@platejs/list/react";
import { IndentPlugin } from "@platejs/indent/react";
import { LinkPlugin } from "@platejs/link/react";
import { CodeBlockPlugin } from "@platejs/code-block/react";
import { TablePlugin } from "@platejs/table/react";
import { ImagePlugin } from "@platejs/media/react";
import { FootnoteDefinitionPlugin, FootnoteReferencePlugin } from "@platejs/footnote/react";
import { MarkdownPlugin, remarkMdx } from "@platejs/markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";

/** No AI SDK, collaboration service, copied UI kit, or custom conversion rule. */
export function editorFor(markdown = "", list: "flat" | "classic" | "kit" = "kit") {
	const editor = createPlateEditor({ plugins: [
		BasicBlocksPlugin, BasicMarksPlugin,
		...(list === "classic" ? [ClassicListPlugin] : [IndentPlugin, ListPlugin]), LinkPlugin,
		CodeBlockPlugin, TablePlugin, ImagePlugin,
		FootnoteDefinitionPlugin, FootnoteReferencePlugin,
		MarkdownPlugin.configure({ options: { remarkPlugins: list === "kit" ? [remarkMath, remarkGfm, remarkMdx] : [remarkGfm] } }),
	] });
	if (markdown) editor.tf.setValue(editor.api.markdown.deserialize(markdown));
	return editor;
}

export function roundTrip(markdown: string, list: "flat" | "classic" | "kit" = "kit") {
	const editor = editorFor(markdown, list);
	return { markdown: editor.api.markdown.serialize(), value: editor.children };
}
