import {
	createPlateEditor,
	PlateElement,
	type PlateEditor,
	type PlateElementProps,
} from "platejs/react";
import { NodeApi } from "platejs";
import {
	BasicBlocksPlugin,
	BasicMarksPlugin,
} from "@platejs/basic-nodes/react";
import {
	FontBackgroundColorPlugin,
	FontColorPlugin,
	FontFamilyPlugin,
	FontSizePlugin,
	LineHeightPlugin,
	TextAlignPlugin,
} from "@platejs/basic-styles/react";
import { ListPlugin } from "@platejs/list/react";
import { IndentPlugin } from "@platejs/indent/react";
import { LinkPlugin } from "@platejs/link/react";
import { CodeBlockPlugin } from "@platejs/code-block/react";
import { TablePlugin } from "@platejs/table/react";
import { ImagePlugin } from "@platejs/media/react";
import { EquationPlugin, InlineEquationPlugin } from "@platejs/math/react";
import {
	FootnoteDefinitionPlugin,
	FootnoteReferencePlugin,
} from "@platejs/footnote/react";
import { CalloutPlugin } from "@platejs/callout/react";
import { TogglePlugin } from "@platejs/toggle/react";
import { TocPlugin } from "@platejs/toc/react";
import { ColumnPlugin, ColumnItemPlugin } from "@platejs/layout/react";
import { MarkdownPlugin, remarkMdx } from "@platejs/markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import katex from "katex";
import "katex/dist/katex.min.css";
import type { MarkdownDocument } from "./types";

const safeUrl = (value: unknown) =>
	typeof value === "string" && /^(https?:|mailto:)/i.test(value)
		? value
		: undefined;
function Element(props: PlateElementProps) {
	const { element, children, editor } = props;
	const type = element.type;
	const attributes = {
		...props.attributes,
		"data-node-type": type,
		"data-list-style":
			typeof element.listStyleType === "string"
				? element.listStyleType
				: undefined,
	};
	if (type === "a")
		return (
			<PlateElement {...props} attributes={attributes} as="span">
				<a
					href={safeUrl(element.url)}
					target="_blank"
					rel="noopener noreferrer"
				>
					{children}
				</a>
			</PlateElement>
		);
	if (type === "img")
		return (
			<PlateElement {...props} attributes={attributes}>
				<span contentEditable={false}>
					<img
						src={safeUrl(element.url)}
						alt={typeof element.alt === "string" ? element.alt : ""}
						loading="lazy"
						referrerPolicy="no-referrer"
					/>
				</span>
				{children}
			</PlateElement>
		);
	if (type === "equation" || type === "inline_equation") {
		const html = katex.renderToString(String(element.tex ?? ""), {
			throwOnError: false,
			trust: false,
			displayMode: type === "equation",
			maxExpand: 1000,
		});
		return (
			<PlateElement
				{...props}
				attributes={attributes}
				as={type === "equation" ? "div" : "span"}
			>
				<span
					contentEditable={false}
					dangerouslySetInnerHTML={{ __html: html }}
				/>
				{children}
			</PlateElement>
		);
	}
	if (type === "hr")
		return (
			<PlateElement {...props} attributes={attributes}>
				<span contentEditable={false}>
					<hr />
				</span>
				{children}
			</PlateElement>
		);
	if (type === "toc")
		return (
			<PlateElement {...props} attributes={attributes}>
				<nav contentEditable={false} aria-label="目次">
					<strong>目次</strong>
					{editor.children
						.filter((n) => /^h[1-6]$/.test(String(n.type)))
						.map((n, i) => (
							<div key={i}>{NodeApi.string(n)}</div>
						))}
				</nav>
				{children}
			</PlateElement>
		);
	if (type === "toggle")
		return (
			<PlateElement {...props} attributes={attributes}>
				<details open>
					<summary contentEditable={false}>詳細</summary>
					{children}
				</details>
			</PlateElement>
		);
	if (type === "footnoteReference")
		return (
			<PlateElement {...props} attributes={attributes} as="sup">
				<span contentEditable={false}>
					[{String(element.identifier ?? "1")}]
				</span>
				{children}
			</PlateElement>
		);
	const tags = {
		p: "div",
		h1: "h1",
		h2: "h2",
		h3: "h3",
		h4: "h4",
		h5: "h5",
		h6: "h6",
		blockquote: "blockquote",
		code_block: "pre",
		code_line: "div",
		code_syntax: "span",
		table: "table",
		tr: "tr",
		td: "td",
		th: "th",
		column_group: "div",
		column: "div",
		callout: "aside",
		footnoteDefinition: "div",
	} as const;
	const tag = tags[type as keyof typeof tags] ?? "div";
	return (
		<PlateElement
			{...props}
			attributes={attributes}
			as={tag}
			style={
				type === "column"
					? { width: String(element.width ?? "50%") }
					: undefined
			}
		>
			{element.listStyleType === "todo" && (
				<input
					type="checkbox"
					contentEditable={false}
					aria-label="完了"
					checked={element.checked === true}
					onChange={() => {
						const at = editor.api.findPath(element);
						if (at)
							editor.tf.setNodes({ checked: element.checked !== true }, { at });
					}}
				/>
			)}
			{children}
		</PlateElement>
	);
}
const keys = [
	"p",
	"h1",
	"h2",
	"h3",
	"h4",
	"h5",
	"h6",
	"blockquote",
	"hr",
	"a",
	"img",
	"code_block",
	"code_line",
	"code_syntax",
	"table",
	"tr",
	"td",
	"th",
	"equation",
	"inline_equation",
	"footnoteDefinition",
	"footnoteReference",
	"callout",
	"toggle",
	"toc",
	"column_group",
	"column",
];
export function createMarkdownEditor(document?: MarkdownDocument): PlateEditor {
	return createPlateEditor({
		plugins: [
			BasicBlocksPlugin,
			BasicMarksPlugin,
			FontColorPlugin,
			FontBackgroundColorPlugin,
			FontFamilyPlugin,
			FontSizePlugin,
			TextAlignPlugin,
			LineHeightPlugin,
			IndentPlugin.configure({
				inject: {
					targetPlugins: [
						"p",
						"h1",
						"h2",
						"h3",
						"h4",
						"h5",
						"h6",
						"blockquote",
					],
				},
			}),
			ListPlugin.configure({
				inject: {
					targetPlugins: [
						"p",
						"h1",
						"h2",
						"h3",
						"h4",
						"h5",
						"h6",
						"blockquote",
					],
				},
			}),
			LinkPlugin,
			CodeBlockPlugin,
			TablePlugin,
			ImagePlugin,
			EquationPlugin,
			InlineEquationPlugin,
			FootnoteDefinitionPlugin,
			FootnoteReferencePlugin,
			CalloutPlugin,
			TogglePlugin,
			TocPlugin,
			ColumnPlugin,
			ColumnItemPlugin,
			MarkdownPlugin.configure({
				options: { remarkPlugins: [remarkGfm, remarkMath, remarkMdx] },
			}),
		],
		override: {
			components: Object.fromEntries(keys.map((key) => [key, Element])),
		},
		value: document ? structuredClone(document.nodes) : undefined,
	});
}
export type MarkdownEditor = PlateEditor;
export const serializeMarkdown = (editor: PlateEditor) =>
	editor.getApi(MarkdownPlugin).markdown.serialize();
export function importMarkdown(text: string): MarkdownDocument {
	const editor = createMarkdownEditor();
	return {
		formatVersion: 1,
		nodes: editor.getApi(MarkdownPlugin).markdown.deserialize(text),
		originalMarkdown: text,
	};
}
