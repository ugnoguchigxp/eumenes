import { afterEach, expect, test, vi } from "vitest";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MarkdownWorkspace } from "./MarkdownWorkspace";
import type {
	MarkdownCurrent,
	MarkdownLibraryEntry,
	MarkdownWorkspaceProps,
} from "./types";
import { documentFolders, findFolder, folderFiles } from "./file-tree";

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});
const entries: MarkdownLibraryEntry[] = [
	{
		sourceId: "one",
		title: "企画書",
		namespace: "eumenes",
		path: "仕事/企画/案.md",
	},
	{
		sourceId: "two",
		title: "議事録",
		namespace: "eumenes",
		path: "仕事/議事録.md",
	},
	{
		sourceId: "three",
		title: "比較資料",
		namespace: "eumenes",
		path: "仕事/企画/参考/比較.md",
	},
	{
		sourceId: "four",
		title: "別領域の企画書",
		namespace: "other",
		path: "仕事/企画/案.md",
	},
];
const current = (): MarkdownCurrent => ({
	id: "local",
	title: "保存した文書",
	document: {
		formatVersion: 1,
		nodes: [{ type: "p", children: [{ text: "本文" }] }],
		originalMarkdown: null,
	},
	revision: 1,
	sourceId: "one",
	dirty: false,
	saveState: "saved",
	saveError: null,
});
const props = (
	item: MarkdownCurrent | null = null,
): MarkdownWorkspaceProps => ({
	current: item,
	documents: [{ id: "local", title: "保存した文書" }],
	library: entries,
	namespaces: ["eumenes", "other"],
	libraryStatus: "ready",
	archiveAvailable: true,
	onDraft: vi.fn(),
	onApply: vi.fn(async () => true),
	onNew: vi.fn(async () => true),
	onSave: vi.fn(async () => true),
	onSelect: vi.fn(),
	onOpen: vi.fn(),
	onLibrary: vi.fn(),
	onReconcile: vi.fn(),
	onMore: vi.fn(),
	onReturn: vi.fn(),
	onResume: vi.fn(),
});
test("folder paths keep equal folder names in different namespaces separate", () => {
	const tree = documentFolders(entries, ["eumenes", "other", "empty"]);
	expect(tree.map((x) => x.namespace)).toEqual(["empty", "eumenes", "other"]);
	expect(
		findFolder(tree, { namespace: "eumenes", path: "仕事" })?.children.map(
			(f) => f.name,
		),
	).toEqual(["企画"]);
	expect(
		folderFiles(entries, { namespace: "eumenes", path: "仕事/企画" }, "").map(
			(x) => x.sourceId,
		),
	).toEqual(["one"]);
	expect(
		folderFiles(entries, { namespace: "eumenes", path: "仕事" }, "比較").map(
			(x) => x.sourceId,
		),
	).toEqual(["three"]);
});
test("folder rows, breadcrumb and file table replace the document selector and button strip", async () => {
	const p = props();
	render(<MarkdownWorkspace {...p} />);
	const nav = screen.getByRole("navigation", { name: "フォルダ" });
	fireEvent.click(within(nav).getByRole("button", { name: "eumenes" }));
	fireEvent.click(
		within(screen.getByRole("table", { name: "保存文書の一覧" })).getByRole(
			"button",
			{ name: "仕事" },
		),
	);
	let table = screen.getByRole("table", { name: "保存文書の一覧" });
	expect(
		within(table).getByRole("button", { name: "企画" }),
	).toBeInTheDocument();
	expect(
		within(table).getByRole("button", { name: "議事録" }),
	).toBeInTheDocument();
	fireEvent.click(within(table).getByRole("button", { name: "企画" }));
	table = screen.getByRole("table", { name: "保存文書の一覧" });
	expect(
		within(table).getByRole("button", { name: "参考" }),
	).toBeInTheDocument();
	expect(
		within(table).getByRole("button", { name: "企画書" }),
	).toBeInTheDocument();
	expect(within(table).queryByText("別領域の企画書")).not.toBeInTheDocument();
	expect(
		screen.getByRole("navigation", { name: "現在のフォルダ" }),
	).toHaveTextContent("Doclingeumenes仕事企画");
	expect(
		screen.queryByRole("combobox", { name: "作業中の文書" }),
	).not.toBeInTheDocument();
	fireEvent.change(
		screen.getByRole("searchbox", { name: "文書名・パスで検索" }),
		{ target: { value: "比較" } },
	);
	expect(
		within(table).getByRole("button", { name: "比較資料" }),
	).toBeInTheDocument();
	fireEvent.click(within(table).getByRole("button", { name: "比較資料" }));
	await waitFor(() => expect(p.onOpen).toHaveBeenCalledWith("three"));
});
test("switching to files and back retains unapplied typing and the icon save has an accessible label", async () => {
	const p = props(current());
	render(<MarkdownWorkspace {...p} />);
	fireEvent.change(screen.getByRole("textbox", { name: "文書名" }), {
		target: { value: "まだ反映していない題名" },
	});
	const save = screen.getByRole("button", { name: "Doclingに保存" });
	expect(save).toHaveTextContent("");
	expect(save.querySelector("svg")).not.toBeNull();
	await userEvent.click(screen.getByRole("tab", { name: "ファイル一覧" }));
	expect(
		screen.queryByRole("textbox", { name: "文書名" }),
	).not.toBeInTheDocument();
	await userEvent.click(screen.getByRole("tab", { name: "編集" }));
	expect(screen.getByRole("textbox", { name: "文書名" })).toHaveValue(
		"まだ反映していない題名",
	);
	expect(p.onApply).not.toHaveBeenCalled();
	expect(p.onSave).not.toHaveBeenCalled();
});
test("idle typing reaches the temporary cache without applying or saving to Docling", async () => {
	const raw = "\uFEFF# 原文\r\n末尾  \r\n",
		item = current();
	item.markdown = raw;
	item.document.originalMarkdown = raw;
	const p = {
		...props(item),
		cacheAvailable: true,
		onCache: vi.fn(async () => true),
	};
	render(<MarkdownWorkspace {...p} />);
	fireEvent.change(screen.getByRole("textbox", { name: "文書名" }), {
		target: { value: "一時保存する題名" },
	});
	await waitFor(() => expect(p.onCache).toHaveBeenCalledTimes(1), {
		timeout: 2500,
	});
	expect(p.onCache).toHaveBeenCalledWith(
		expect.objectContaining({
			title: "一時保存する題名",
			document: item.document,
		}),
		raw,
		expect.stringMatching(/^[0-9a-f-]{36}$/),
	);
	expect(screen.getByText("cacheに一時保存済み")).toBeInTheDocument();
	expect(p.onApply).not.toHaveBeenCalled();
	expect(p.onSave).not.toHaveBeenCalled();
});
test("a failed open stays in the library; loading, empty, error and more have distinct states", async () => {
	const p = {
			...props(),
			library: [],
			namespaces: ["eumenes"],
			libraryStatus: "loading" as const,
		},
		view = render(<MarkdownWorkspace {...p} />);
	expect(screen.getByRole("status")).toHaveTextContent("読み込んでいます");
	expect(
		screen.queryByText("このフォルダには文書がありません。"),
	).not.toBeInTheDocument();
	view.rerender(<MarkdownWorkspace {...p} libraryStatus="ready" />);
	expect(
		screen.getByText("このフォルダには文書がありません。"),
	).toBeInTheDocument();
	view.rerender(<MarkdownWorkspace {...p} libraryStatus="error" />);
	expect(screen.getByRole("alert")).toHaveTextContent(
		"一覧を読み込めませんでした",
	);
	const denied = {
		...props(current()),
		libraryStatus: "ready" as const,
		onOpen: vi.fn(async () => false),
	};
	view.rerender(<MarkdownWorkspace {...denied} libraryHasMore />);
	await userEvent.click(screen.getByRole("tab", { name: "ファイル一覧" }));
	fireEvent.change(
		screen.getByRole("searchbox", { name: "文書名・パスで検索" }),
		{ target: { value: "企画書" } },
	);
	fireEvent.click(screen.getByRole("button", { name: "企画書" }));
	await waitFor(() => expect(denied.onOpen).toHaveBeenCalledWith("one"));
	expect(screen.getByRole("tab", { name: "ファイル一覧" })).toHaveAttribute(
		"aria-selected",
		"true",
	);
	fireEvent.click(screen.getByRole("button", { name: "続きを読み込む" }));
	expect(denied.onMore).toHaveBeenCalled();
});
