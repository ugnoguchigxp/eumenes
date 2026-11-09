import { afterEach, expect, test, vi } from "vitest";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { MarkdownWorkspace } from "./MarkdownWorkspace";
import userEvent from "@testing-library/user-event";
import { makeLibraryCommand } from "./library-actions";
import type { MarkdownWorkspaceProps } from "./types";

afterEach(() => cleanup());
const id = "wiki-" + "a".repeat(32),
	otherId = "wiki-" + "d".repeat(32),
	folderId = "folder-" + "f".repeat(32),
	etag = '"' + "b".repeat(64) + '"',
	libraryEtag = '"' + "c".repeat(64) + '"';
function fixture(): MarkdownWorkspaceProps {
	return {
		current: {
			id: "workspace",
			title: "編集中の文書",
			revision: 1,
			document: {
				formatVersion: 1,
				nodes: [{ type: "p", children: [{ text: "本文" }] }],
				originalMarkdown: null,
			},
			sourceId: id,
			remote: { id, namespace: "other-space", path: "別階層/文書.md", etag },
			dirty: false,
			saveState: "saved",
			saveError: null,
		},
		documents: [],
		library: [],
		namespaces: ["eumenes"],
		archiveAvailable: true,
		capabilities: {
			maxMarkdownBytes: 8e6,
			maxRecoveryBytes: 8e6,
			maxRequestBytes: 20e6,
			features: {
				library: true,
				folders: true,
				patch: true,
				copy: true,
				delete: true,
				createFolder: true,
				recursiveDelete: true,
				batch: true,
				maxBatchItems: 100,
				maxAffectedItems: 500,
				maxCopyBytes: 20e6,
			},
		},
		files: {
			namespace: "eumenes",
			path: "",
			etag: libraryEtag,
			nextCursor: null,
			entries: [
				{
					kind: "document",
					id: otherId,
					namespace: "eumenes",
					path: "選択文書.md",
					etag,
					title: "一覧の文書",
				},
				{
					kind: "folder",
					id: folderId,
					namespace: "eumenes",
					path: "選択フォルダー",
					etag,
					documentCount: 2,
					folderCount: 0,
				},
			],
		},
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
		onFiles: vi.fn(),
		onManage: vi.fn(async () => true),
		onReload: vi.fn(async () => true),
	};
}
const deleteButton = () => screen.getByRole("button", { name: /^削除$/ });

test("the header has one icon-only delete action and explains unsupported storage", () => {
	const p = fixture();
	p.capabilities!.features!.delete = false;
	render(<MarkdownWorkspace {...p} />);
	expect(deleteButton().textContent).toBe("");
	expect(
		deleteButton().closest(".ds-markdown-header-actions"),
	).toContainElement(screen.getByRole("button", { name: "新規文書" }));
	expect(
		deleteButton().closest(".ds-markdown-header-actions"),
	).toContainElement(
		screen.getByRole("button", { name: "Markdownを読み込む" }),
	);
	expect(deleteButton()).toBeDisabled();
	expect(deleteButton()).toHaveAttribute(
		"title",
		"保存先が削除機能に対応していません",
	);
	fireEvent.click(deleteButton());
	expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
	expect(p.onManage).not.toHaveBeenCalled();
});
test("editor deletion uses the opened document ID and ETag outside the loaded namespace, after confirmation only", async () => {
	const p = fixture();
	delete p.files;
	render(<MarkdownWorkspace {...p} />);
	fireEvent.click(deleteButton());
	expect(screen.getByRole("dialog")).toHaveTextContent(
		"other-space/別階層/文書.md",
	);
	expect(p.onManage).not.toHaveBeenCalled();
	fireEvent.click(screen.getByRole("button", { name: "キャンセル" }));
	expect(p.onManage).not.toHaveBeenCalled();
	fireEvent.click(deleteButton());
	fireEvent.click(screen.getByRole("button", { name: "削除する" }));
	await waitFor(() =>
		expect(p.onManage).toHaveBeenCalledExactlyOnceWith(
			{ op: "delete", kind: "document", id, namespace: "other-space", etag },
			expect.any(String),
		),
	);
});
test("list deletion uses the checked items and library ETag instead of the open document", async () => {
	const p = fixture();
	render(<MarkdownWorkspace {...p} />);
	await userEvent.click(screen.getByRole("tab", { name: "ファイル一覧" }));
	expect(screen.getByRole("tab", { name: "ファイル一覧" })).toHaveAttribute(
		"aria-selected",
		"true",
	);
	expect(deleteButton()).toBeDisabled();
	await userEvent.click(
		within(screen.getByRole("navigation", { name: "フォルダ" })).getByRole(
			"button",
			{ name: "eumenes" },
		),
	);
	fireEvent.click(screen.getByRole("checkbox", { name: "表示中をすべて選択" }));
	fireEvent.click(deleteButton());
	const dialog = screen.getByRole("dialog");
	expect(dialog).toHaveTextContent("eumenes/選択文書.md");
	expect(dialog).toHaveTextContent("eumenes/選択フォルダー");
	expect(dialog).not.toHaveTextContent("other-space/別階層/文書.md");
	fireEvent.click(within(dialog).getByRole("button", { name: "削除する" }));
	await waitFor(() =>
		expect(p.onManage).toHaveBeenCalledExactlyOnceWith(
			{
				op: "batch",
				namespace: "eumenes",
				etag: libraryEtag,
				action: "delete",
				items: [
					{ kind: "document", id: otherId },
					{ kind: "folder", id: folderId },
				],
			},
			expect.any(String),
		),
	);
});
test.each(["etag", "path", "namespace"] as const)(
	"a changed %s clears the list selection, including when returning to the old page",
	(field) => {
		const p = fixture();
		p.current = null;
		const view = render(<MarkdownWorkspace {...p} />);
		fireEvent.click(
			screen.getByRole("checkbox", { name: "選択文書.mdを選択" }),
		);
		expect(deleteButton()).toBeEnabled();
		view.rerender(
			<MarkdownWorkspace
				{...p}
				files={{
					...p.files!,
					[field]: field === "etag" ? '"' + "e".repeat(64) + '"' : "別",
				}}
			/>,
		);
		expect(deleteButton()).toBeDisabled();
		view.rerender(<MarkdownWorkspace {...p} />);
		expect(deleteButton()).toBeDisabled();
		expect(p.onManage).not.toHaveBeenCalled();
	},
);
test("opening work documents clears the hidden canonical selection", () => {
	const p = fixture();
	p.current = null;
	render(<MarkdownWorkspace {...p} />);
	fireEvent.click(screen.getByRole("checkbox", { name: "選択文書.mdを選択" }));
	expect(deleteButton()).toBeEnabled();
	fireEvent.click(screen.getByRole("button", { name: "作業用の文書" }));
	expect(deleteButton()).toBeDisabled();
});
test("unapplied editor input requires the existing explicit save or discard flow", async () => {
	const p = fixture();
	render(<MarkdownWorkspace {...p} />);
	fireEvent.change(screen.getByRole("textbox", { name: "文書名" }), {
		target: { value: "未保存の題名" },
	});
	fireEvent.click(deleteButton());
	expect(screen.getByRole("dialog")).toHaveTextContent(
		"未保存の編集があります",
	);
	expect(
		screen.queryByRole("button", { name: "削除する" }),
	).not.toBeInTheDocument();
	fireEvent.click(screen.getByRole("button", { name: "キャンセル" }));
	expect(screen.getByRole("textbox", { name: "文書名" })).toHaveValue(
		"未保存の題名",
	);
	expect(p.onManage).not.toHaveBeenCalled();
	fireEvent.click(deleteButton());
	fireEvent.click(screen.getByRole("button", { name: "変更を破棄して続行" }));
	await waitFor(() =>
		expect(screen.getByRole("button", { name: "削除する" })).toBeEnabled(),
	);
	expect(p.onReload).toHaveBeenCalledExactlyOnceWith(id, 1);
	expect(p.onDraft).toHaveBeenLastCalledWith(null);
	expect(p.onManage).not.toHaveBeenCalled();
});
test("save-in-progress, unknown operations, and unsaved-only documents disable editor deletion", () => {
	const p = fixture(),
		view = render(
			<MarkdownWorkspace
				{...p}
				current={{ ...p.current!, saveState: "saving" }}
			/>,
		);
	expect(deleteButton()).toBeDisabled();
	view.rerender(
		<MarkdownWorkspace
			{...p}
			operations={[
				{
					id: "operation",
					state: "unknown",
					code: null,
					command: {},
					removedWorkspaceIds: [],
				},
			]}
		/>,
	);
	expect(deleteButton()).toBeDisabled();
	view.rerender(
		<MarkdownWorkspace
			{...p}
			current={{ ...p.current!, sourceId: null, remote: null }}
		/>,
	);
	expect(deleteButton()).toBeDisabled();
	expect(p.onManage).not.toHaveBeenCalled();
});
test("multiple targets require batch support and an actual library ETag", () => {
	const p = fixture();
	p.current = null;
	p.capabilities!.features!.batch = false;
	render(<MarkdownWorkspace {...p} />);
	fireEvent.click(screen.getByRole("checkbox", { name: "表示中をすべて選択" }));
	expect(deleteButton()).toBeDisabled();
	expect(() =>
		makeLibraryCommand({
			action: "delete",
			items: p.files!.entries,
			namespace: "eumenes",
			path: "",
			title: "",
			recursive: false,
			ids: {},
		}),
	).toThrow("library_etag_required");
});
