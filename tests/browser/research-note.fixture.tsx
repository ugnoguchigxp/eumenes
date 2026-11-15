import { createRoot } from "react-dom/client";
import {
	MarkdownWorkspace,
	importMarkdown,
} from "@eumenes/design-system/markdown";
import "@eumenes/design-system/styles";

const markdown = `# 調査メモ\n\n2026-11-15時点。\n\n${Array.from({ length: 110 }, (_, i) => `段落${i + 1}: ${"条件と根拠の説明。".repeat(10)}`).join("\n\n")}\n\n末尾の留保: 地域ごとの条件は未確認。\n\n## 出典\n\n- [一次資料](https://example.com/original)\n`;
const current = {
	id: "research-note",
	title: "調査メモ",
	document: importMarkdown(markdown),
	markdown,
	revision: 1,
	sourceId: `wiki-${"a".repeat(32)}`,
	remote: {
		id: `wiki-${"a".repeat(32)}`,
		etag: `"${"b".repeat(64)}"`,
		namespace: "eumenes",
		path: "notes/調査メモ.md",
	},
	dirty: false,
	saveState: "saved",
	saveError: null,
};
createRoot(document.getElementById("root")!).render(
	<MarkdownWorkspace
		current={current}
		documents={[]}
		library={[]}
		archiveAvailable
		onDraft={() => {}}
		onApply={async () => true}
		onNew={async () => true}
		onSave={async () => true}
		onSelect={() => {}}
		onOpen={() => {}}
		onLibrary={() => {}}
		onReconcile={() => {}}
		onReturn={() => {}}
		onResume={() => {}}
	/>,
);
