import { useState } from "react";
import {
	serializeMarkdown,
	exportWarning,
	type MarkdownEditor,
} from "./editor";
function download(text: string, name: string) {
	const url = URL.createObjectURL(
		new Blob([text], { type: "text/markdown;charset=utf-8" }),
	);
	const a = document.createElement("a");
	a.href = url;
	a.download = name;
	a.click();
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function MarkdownDocumentFooter({
	editor,
	title,
	originalMarkdown,
	busy,
}: {
	editor: MarkdownEditor;
	title: string;
	originalMarkdown: string | null;
	busy?: boolean;
}) {
	const [source, setSource] = useState(false);
	return (
		<>
			<footer className="ds-markdown-footer">
				<span>
					{busy
						? "共同編集の応答待ち"
						: "文書のどの部分でも会話から編集を依頼できます"}
				</span>
				<button onClick={() => setSource(!source)}>Markdownを確認</button>
				<button
					onClick={() =>
						download(serializeMarkdown(editor), `${title || "無題"}.md`)
					}
				>
					Markdownを書出
				</button>
				{originalMarkdown !== null && (
					<button
						onClick={() =>
							download(originalMarkdown, `${title || "無題"}-取込原文.md`)
						}
					>
						取込原文
					</button>
				)}
			</footer>
			<small className="ds-markdown-warning">{exportWarning}</small>
			{source && (
				<textarea
					aria-label="書出しMarkdown（確認用）"
					className="ds-markdown-source"
					readOnly
					value={serializeMarkdown(editor)}
				/>
			)}
		</>
	);
}
