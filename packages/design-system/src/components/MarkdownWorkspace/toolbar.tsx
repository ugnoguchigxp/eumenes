import { useState } from "react";
import { toggleList, indentList, outdentList } from "@platejs/list";
import { FootnoteReferencePlugin } from "@platejs/footnote/react";
import { TablePlugin } from "@platejs/table/react";
import type { MarkdownEditor } from "./editor";

export function MarkdownToolbar({
	editor,
	disabled,
}: {
	editor: MarkdownEditor;
	disabled: boolean;
}) {
	const [prompt, setPrompt] = useState<"link" | "img" | "equation" | null>(
			null,
		),
		[value, setValue] = useState("");
	const run = (action: () => void, history = true) => {
		if (disabled) return;
		// Native selection can precede Slate's debounced selectionchange (e.g. Shift+End then click).
		const selection = window.getSelection();
		const range = selection?.rangeCount
			? editor.api.toSlateRange(selection, {
					exactMatch: false,
					suppressThrow: true,
				})
			: null;
		if (range) editor.tf.select(range);
		if (history) editor.tf.withNewBatch(action);
		else action();
		editor.tf.focus();
	};
	const button = (
		label: string,
		text: string,
		action: () => void,
		history = true,
	) => (
		<button
			type="button"
			title={label}
			aria-label={label}
			onMouseDown={(e) => e.preventDefault()}
			onClick={() => run(action, history)}
			disabled={disabled}
		>
			{text}
		</button>
	);
	const insert = (type: string, extra: Record<string, unknown> = {}) =>
		editor.tf.insertNodes({ type, ...extra, children: [{ text: "" }] });
	return (
		<div className="ds-markdown-toolbar" role="toolbar" aria-label="文書の書式">
			<TextTools
				editor={editor}
				disabled={disabled}
				button={button}
				run={run}
			/>
			<BlockTools
				editor={editor}
				disabled={disabled}
				button={button}
				run={run}
				insert={insert}
				choose={(kind) => {
					setValue("");
					setPrompt(kind);
				}}
			/>
			{prompt && (
				<form
					className="ds-markdown-insert"
					onSubmit={(e) => {
						e.preventDefault();
						if (prompt !== "equation" && !/^(https?:|mailto:)/i.test(value))
							return;
						run(() => {
							if (prompt === "link")
								editor.tf.insertNodes({
									type: "a",
									url: value,
									children: [{ text: value }],
								});
							else
								insert(prompt, {
									[prompt === "equation" ? "tex" : "url"]: value,
								});
						});
						setPrompt(null);
					}}
				>
					<label>
						{prompt === "equation" ? "数式（LaTeX）" : "URL"}
						<input
							value={value}
							maxLength={2000}
							onChange={(e) => setValue(e.target.value)}
						/>
					</label>
					<button type="submit">挿入</button>
					<button type="button" onClick={() => setPrompt(null)}>
						閉じる
					</button>
				</form>
			)}
		</div>
	);
}

type Controls = {
	editor: MarkdownEditor;
	disabled: boolean;
	button: (
		label: string,
		text: string,
		action: () => void,
		history?: boolean,
	) => React.ReactNode;
	run: (action: () => void) => void;
};
function TextTools({ editor, disabled, button, run }: Controls) {
	return (
		<div className="ds-markdown-tools">
			{button("元に戻す", "↶", () => editor.tf.undo(), false)}
			{button("やり直す", "↷", () => editor.tf.redo(), false)}
			<select
				aria-label="見出し"
				disabled={disabled}
				defaultValue=""
				onChange={(e) => {
					run(() => editor.tf.setNodes({ type: e.target.value }));
					e.target.value = "";
				}}
			>
				<option value="" disabled>
					本文・見出し
				</option>
				{["p", "h1", "h2", "h3", "h4", "h5", "h6"].map((type, i) => (
					<option key={type} value={type}>
						{i ? `見出し ${i}` : "本文"}
					</option>
				))}
			</select>
			<select
				aria-label="フォント"
				disabled={disabled}
				defaultValue=""
				onChange={(e) =>
					run(() => editor.tf.addMark("fontFamily", e.target.value))
				}
			>
				<option value="">標準フォント</option>
				<option value="sans-serif">ゴシック</option>
				<option value="serif">明朝</option>
				<option value="monospace">等幅</option>
			</select>
			<select
				aria-label="文字サイズ"
				disabled={disabled}
				defaultValue="16px"
				onChange={(e) =>
					run(() => editor.tf.addMark("fontSize", e.target.value))
				}
			>
				{[12, 14, 16, 18, 24, 32, 40].map((n) => (
					<option key={n} value={`${n}px`}>
						{n}
					</option>
				))}
			</select>
			{[
				["bold", "太字", "B"],
				["italic", "斜体", "I"],
				["underline", "下線", "U"],
				["strikethrough", "取り消し線", "S"],
				["code", "インラインコード", "<>"],
				["subscript", "下付き", "x₂"],
				["superscript", "上付き", "x²"],
			].map(([key, label, text]) => (
				<span key={key}>
					{button(label!, text!, () => editor.tf.toggleMark(key!))}
				</span>
			))}
			<label title="文字色">
				A
				<input
					type="color"
					aria-label="文字色"
					disabled={disabled}
					defaultValue="#202938"
					onChange={(e) =>
						run(() => editor.tf.addMark("color", e.target.value))
					}
				/>
			</label>
			<label title="背景色">
				▰
				<input
					type="color"
					aria-label="背景色"
					disabled={disabled}
					defaultValue="#fff1a8"
					onChange={(e) =>
						run(() => editor.tf.addMark("backgroundColor", e.target.value))
					}
				/>
			</label>
			{button("書式を解除", "Tx", () => {
				for (const key of [
					"bold",
					"italic",
					"underline",
					"strikethrough",
					"code",
					"subscript",
					"superscript",
					"color",
					"backgroundColor",
					"fontFamily",
					"fontSize",
				])
					editor.tf.removeMark(key);
			})}
		</div>
	);
}
function BlockTools({
	editor,
	disabled,
	button,
	run,
	insert,
	choose,
}: Controls & {
	insert: (type: string, extra?: Record<string, unknown>) => void;
	choose: (kind: "link" | "img" | "equation") => void;
}) {
	return (
		<div className="ds-markdown-tools">
			{[
				["left", "左揃え", "≡←"],
				["center", "中央揃え", "≡"],
				["right", "右揃え", "→≡"],
				["justify", "均等割付", "☰"],
			].map(([align, label, text]) => (
				<span key={align}>
					{button(label!, text!, () => editor.tf.setNodes({ align }))}
				</span>
			))}
			<select
				aria-label="行間"
				disabled={disabled}
				defaultValue="1.5"
				onChange={(e) =>
					run(() => editor.tf.setNodes({ lineHeight: Number(e.target.value) }))
				}
			>
				{[1, 1.5, 2, 2.5].map((n) => (
					<option key={n} value={n}>
						行間 {n}
					</option>
				))}
			</select>
			{button("箇条書き", "•", () =>
				toggleList(editor, { listStyleType: "disc" }),
			)}
			{button("番号リスト", "1.", () =>
				toggleList(editor, { listStyleType: "decimal" }),
			)}
			{button("チェックリスト", "☑", () =>
				toggleList(editor, { listStyleType: "todo" }),
			)}
			{button("字下げ", "⇥", () => indentList(editor))}
			{button("字下げ解除", "⇤", () => outdentList(editor))}
			{button("引用", "❝", () => editor.tf.setNodes({ type: "blockquote" }))}
			{button("リンク", "🔗", () => {
				choose("link");
			})}
			{button("画像", "▧", () => {
				choose("img");
			})}
			{button("表を挿入", "▦", () =>
				editor
					.getTransforms(TablePlugin)
					.insert.table({ rowCount: 3, colCount: 3 }),
			)}
			{button("行を追加", "行+", () =>
				editor.getTransforms(TablePlugin).insert.tableRow(),
			)}
			{button("列を追加", "列+", () =>
				editor.getTransforms(TablePlugin).insert.tableColumn(),
			)}
			{button("行を削除", "行−", () =>
				editor.getTransforms(TablePlugin).remove.tableRow(),
			)}
			{button("列を削除", "列−", () =>
				editor.getTransforms(TablePlugin).remove.tableColumn(),
			)}
			{button("コードブロック", "{ }", () =>
				editor.tf.insertNodes({
					type: "code_block",
					children: [{ type: "code_line", children: [{ text: "" }] }],
				}),
			)}
			{button("数式", "∑", () => {
				choose("equation");
			})}
			{button("脚注", "注¹", () => insertFootnote(editor))}
			{button("区切り線", "―", () => insert("hr"))}
			{button("コールアウト", "💡", () => insert("callout"))}
			{button("折りたたみ", "▸", () => insert("toggle"))}
			{button("目次", "目次", () => insert("toc"))}
			{button("二段組み", "▥", () =>
				editor.tf.insertNodes({
					type: "column_group",
					children: [1, 2].map(() => ({
						type: "column",
						width: "50%",
						children: [{ type: "p", children: [{ text: "" }] }],
					})),
				}),
			)}
			<select
				aria-label="絵文字"
				disabled={disabled}
				value=""
				onChange={(e) => run(() => editor.tf.insertText(e.target.value))}
			>
				<option value="" disabled>
					☺
				</option>
				{["😀", "👍", "✅", "💡", "📌", "🎉", "⚠️", "❤️"].map((emoji) => (
					<option key={emoji}>{emoji}</option>
				))}
			</select>
		</div>
	);
}

function insertFootnote(editor: MarkdownEditor) {
	editor
		.getTransforms(FootnoteReferencePlugin)
		.insert.footnote({ focusDefinition: true });
}
