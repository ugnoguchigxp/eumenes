import { afterEach, expect, test, vi } from "vitest";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { MarkdownWorkspace } from "./MarkdownWorkspace";
import type { MarkdownWorkspaceProps, MarkdownCurrent } from "./types";

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});
const current = (): MarkdownCurrent => ({
	id: "local",
	title: "題名",
	document: {
		formatVersion: 1,
		nodes: [
			{ type: "p", align: "center", children: [{ text: "本文", bold: true }] },
		],
		originalMarkdown: "\uFEFF# 原文\r\n末尾  \r\n",
	},
	markdown: "\uFEFF# 本文\r\n末尾  \r\n",
	revision: 1,
	sourceId: `wiki-${"a".repeat(32)}`,
	remote: {
		id: `wiki-${"a".repeat(32)}`,
		etag: '"' + "b".repeat(64) + '"',
		namespace: "eumenes",
		path: "notes/確認.md",
	},
	dirty: false,
	saveState: "saved",
	saveError: null,
});
const props = (value = current()): MarkdownWorkspaceProps => ({
	current: value,
	documents: [],
	library: [],
	archiveAvailable: true,
	onDraft: vi.fn(),
	onApply: vi.fn(async () => true),
	onNew: vi.fn(async () => true),
	onSave: vi.fn(async () => true),
	onSelect: vi.fn(),
	onOpen: vi.fn(),
	onLibrary: vi.fn(),
	onReconcile: vi.fn(),
	onReturn: vi.fn(),
	onResume: vi.fn(),
});
const conflict = () => {
	const c = current();
	c.saveState = "conflict";
	c.saveError = "markdown_archive_conflict";
	c.conflict = {
		entry: {
			sourceId: c.sourceId!,
			title: "外の題名",
			revision: '"' + "c".repeat(64) + '"',
			namespace: "eumenes",
			path: "notes/確認.md",
		},
		markdown: "外の本文",
		recovery: JSON.stringify(c.document),
	};
	return c;
};
test("a temporary document renders Markdown through Plate in read-only mode", () => {
	const p = props();
	render(
		<MarkdownWorkspace
			{...p}
			current={null}
			preview={{
				title: "比較調査",
				markdown: "## 結論\n\n[出典](https://example.com/source)",
			}}
		/>,
	);
	expect(screen.getByRole("heading", { name: "結論" })).toBeTruthy();
	expect(screen.getByRole("link", { name: "出典" }).getAttribute("href")).toBe(
		"https://example.com/source",
	);
	expect(
		screen.getByLabelText("文書本文").getAttribute("contenteditable"),
	).toBe("false");
	expect(p.onDraft).not.toHaveBeenCalled();
});
test("header download exports the current unsaved title and body as Markdown without saving", async () => {
	const createObjectURL = vi.fn((_blob: Blob) => "blob:markdown-download"),
		revokeObjectURL = vi.fn();
	vi.stubGlobal(
		"URL",
		class extends URL {
			static createObjectURL = createObjectURL;
			static revokeObjectURL = revokeObjectURL;
		},
	);
	const click = vi
		.spyOn(HTMLAnchorElement.prototype, "click")
		.mockImplementation(() => {});
	const p = props();
	render(
		<MarkdownWorkspace
			{...p}
			recovery={{
				documentId: "local",
				baseRevision: 1,
				title: "復元した下書き",
				document: {
					formatVersion: 1,
					nodes: [{ type: "p", children: [{ text: "未保存の本文" }] }],
					originalMarkdown: "別の取込原文",
				},
			}}
		/>,
	);
	fireEvent.change(screen.getByRole("textbox", { name: "文書名" }), {
		target: { value: "変更後の題名" },
	});
	fireEvent.click(screen.getByRole("tab", { name: "ファイル一覧" }));
	const button = screen.getByRole("button", {
		name: "Markdownをダウンロード",
	});
	expect(button.textContent).toBe("");
	expect(button.parentElement).toBe(
		screen.getByRole("button", { name: "Markdownを読み込む" }).parentElement,
	);
	fireEvent.click(button);
	expect(click).toHaveBeenCalledOnce();
	expect(click.mock.instances[0]).toHaveAttribute(
		"download",
		"変更後の題名.md",
	);
	const blob = createObjectURL.mock.calls[0]![0] as Blob;
	expect(blob.type).toBe("text/markdown;charset=utf-8");
	const text = await new Promise<string>((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(String(reader.result));
		reader.onerror = reject;
		reader.readAsText(blob);
	});
	expect(text.trim()).toBe("未保存の本文");
	expect(p.onApply).not.toHaveBeenCalled();
	expect(p.onSave).not.toHaveBeenCalled();
	await waitFor(
		() =>
			expect(revokeObjectURL).toHaveBeenCalledWith("blob:markdown-download"),
		{ timeout: 1500 },
	);
});

test("Markdown download is disabled without an open document and the footer is removed", () => {
	const p = props();
	const view = render(<MarkdownWorkspace {...p} />);
	expect(screen.queryByRole("button", { name: "Markdownを確認" })).toBeNull();
	expect(screen.queryByRole("button", { name: "Markdownを書出" })).toBeNull();
	expect(screen.queryByRole("button", { name: "取込原文" })).toBeNull();
	expect(
		screen.queryByText("文書のどの部分でも会話から編集を依頼できます"),
	).toBeNull();
	expect(screen.queryByText(/Markdownの読込み・書出しでは/)).toBeNull();
	view.rerender(<MarkdownWorkspace {...p} current={null} />);
	expect(
		screen.getByRole("button", { name: "Markdownをダウンロード" }),
	).toBeDisabled();
});

test("untouched Markdown stays exact and title whitespace survives an apply-and-save", async () => {
	const p = props(),
		view = render(<MarkdownWorkspace {...p} />);
	fireEvent.click(screen.getByRole("button", { name: "Doclingに保存" }));
	expect(p.onSave).toHaveBeenCalledWith("local", 1, p.current!.markdown);
	fireEvent.change(screen.getByRole("textbox", { name: "文書名" }), {
		target: { value: "  日本語の題名  " },
	});
	fireEvent.click(screen.getByRole("button", { name: "Doclingに保存" }));
	await waitFor(() => expect(p.onApply).toHaveBeenCalled());
	const draft = vi.mocked(p.onApply).mock.calls[0]![0];
	expect(draft.title).toBe("  日本語の題名  ");
	expect(draft.document).toEqual(p.current!.document);
	view.rerender(
		<MarkdownWorkspace
			{...p}
			current={{
				...p.current!,
				revision: 2,
				title: draft.title,
				document: draft.document,
				dirty: true,
			}}
		/>,
	);
	await waitFor(() =>
		expect(p.onSave).toHaveBeenLastCalledWith("local", 2, p.current!.markdown),
	);
});
test("a completed save does not mark later typing saved", () => {
	const p = props({ ...current(), saveState: "saving" }),
		view = render(<MarkdownWorkspace {...p} />);
	fireEvent.change(screen.getByRole("textbox", { name: "文書名" }), {
		target: { value: "保存中の追記" },
	});
	expect(screen.getByText(/Doclingに保存中/)).toBeInTheDocument();
	view.rerender(
		<MarkdownWorkspace
			{...p}
			current={{ ...p.current!, saveState: "saved" }}
		/>,
	);
	expect(screen.getByRole("textbox", { name: "文書名" })).toHaveValue(
		"保存中の追記",
	);
	expect(screen.getByText("未保存（作業用下書き）")).toBeInTheDocument();
});
test("choosing the local conflict preserves unapplied typing and only adopts the explicit base", async () => {
	vi.spyOn(window, "confirm").mockReturnValue(true);
	const p = {
			...props(conflict()),
			sessionState: "active" as const,
			onResolve: vi.fn(async () => true),
		},
		view = render(<MarkdownWorkspace {...p} />);
	fireEvent.change(screen.getByRole("textbox", { name: "文書名" }), {
		target: { value: "手元の変更" },
	});
	fireEvent.click(screen.getByRole("button", { name: "手元の編集を使う" }));
	await waitFor(() =>
		expect(p.onResolve).toHaveBeenCalledWith(
			"local",
			1,
			p.current!.conflict!.entry.revision,
		),
	);
	view.rerender(
		<MarkdownWorkspace
			{...p}
			current={{
				...p.current!,
				revision: 2,
				saveState: "unsaved",
				saveError: null,
				conflict: null,
				dirty: true,
			}}
		/>,
	);
	await waitFor(() =>
		expect(
			screen.getByRole("button", { name: "共同編集に反映" }),
		).toBeEnabled(),
	);
	expect(screen.getByRole("textbox", { name: "文書名" })).toHaveValue(
		"手元の変更",
	);
	expect(p.onSave).not.toHaveBeenCalled();
});
test("typing after a remote reload starts survives its late response", async () => {
	vi.spyOn(window, "confirm").mockReturnValue(true);
	let resolve!: (value: boolean) => void;
	const gate = {
			promise: new Promise<boolean>((r) => {
				resolve = r;
			}),
			resolve: (value: boolean) => resolve(value),
		},
		p = { ...props(conflict()), onReload: vi.fn(() => gate.promise) },
		view = render(<MarkdownWorkspace {...p} />);
	fireEvent.change(screen.getByRole("textbox", { name: "文書名" }), {
		target: { value: "破棄を選んだ時点" },
	});
	fireEvent.click(
		screen.getByRole("button", { name: "Doclingの最新版を使う" }),
	);
	fireEvent.change(screen.getByRole("textbox", { name: "文書名" }), {
		target: { value: "読込み中に入力した変更" },
	});
	view.rerender(
		<MarkdownWorkspace
			{...p}
			current={{
				...p.current!,
				revision: 2,
				title: "Doclingの最新版",
				saveState: "saved",
				saveError: null,
				conflict: null,
			}}
		/>,
	);
	gate.resolve(true);
	await waitFor(() =>
		expect(screen.getByRole("textbox", { name: "文書名" })).toHaveValue(
			"読込み中に入力した変更",
		),
	);
	expect(p.onDraft).not.toHaveBeenCalledWith(null);
	expect(
		screen.getByText(/別の編集が先に反映されています/),
	).toBeInTheDocument();
});

test("a Markdown-imported heading and bold paragraph keep their stored tree on a title-only edit", async () => {
	const { importMarkdown } = await import("./editor");
	const raw =
		"\uFEFF# 日本語の見出し\r\n\r\n**装飾付きの日本語**  \r\n\r\n容量確認  \r\n";
	const c = { ...current(), document: importMarkdown(raw), markdown: raw },
		p = props(c);
	render(<MarkdownWorkspace {...p} />);
	fireEvent.change(screen.getByRole("textbox", { name: "文書名" }), {
		target: { value: "題名だけを変更" },
	});
	fireEvent.click(screen.getByRole("button", { name: "Doclingに保存" }));
	await waitFor(() => expect(p.onApply).toHaveBeenCalled());
	expect(vi.mocked(p.onApply).mock.calls[0]![0].document).toEqual(c.document);
});
