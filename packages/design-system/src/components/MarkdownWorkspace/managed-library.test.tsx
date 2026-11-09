import { afterEach, expect, test, vi } from "vitest";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	within,
	waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ManagedLibrary } from "./managed-library";
import type { MarkdownWorkspaceProps } from "./types";
import { makeLibraryCommand, selectedRoots } from "./library-actions";
afterEach(() => cleanup());
const doc = "wiki-" + "1".repeat(32),
	folder = "folder-" + "a".repeat(32),
	etag = '"' + "b".repeat(64) + '"',
	libraryTag = '"' + "c".repeat(64) + '"';
function fixture() {
	const p: MarkdownWorkspaceProps & {
		localInput: boolean;
		onEditLocal: (id: string) => void;
		onEditRemote: (id: string) => void;
	} = {
		current: null,
		documents: [],
		library: [],
		namespaces: ["eumenes"],
		archiveAvailable: true,
		localInput: false,
		capabilities: {
			maxMarkdownBytes: 8e6,
			maxRecoveryBytes: 8e6,
			maxRequestBytes: 20e6,
			features: {
				library: true,
				folders: true,
				folderCopy: true,
				patch: true,
				copy: true,
				delete: true,
				createFolder: true,
				recursiveDelete: true,
				batch: true,
				maxBatchItems: 100,
				maxAffectedItems: 500,
				maxCopyBytes: 20971520,
			},
		},
		files: {
			namespace: "eumenes",
			path: "",
			etag: libraryTag,
			nextCursor: null,
			entries: [
				{
					kind: "folder",
					id: folder,
					namespace: "eumenes",
					path: "空",
					name: "空",
					etag,
					documentCount: 0,
					folderCount: 0,
					hasUnsupportedEntries: false,
				},
				{
					kind: "document",
					id: doc,
					namespace: "eumenes",
					path: "文書.md",
					title: "文書の題名",
					etag,
				},
			],
		},
		knownFolders: [
			{
				kind: "folder",
				id: folder,
				namespace: "eumenes",
				path: "空",
				name: "空",
				etag,
			},
		],
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
		onCheck: vi.fn(),
		onEditLocal: vi.fn(),
		onEditRemote: vi.fn(),
	};
	return p;
}

function startMove(source: HTMLElement) {
	const data = new Map<string, string>();
	const dataTransfer = {
		get types() {
			return [...data.keys()];
		},
		setData: (type: string, value: string) => data.set(type, value),
		getData: (type: string) => data.get(type) ?? "",
		effectAllowed: "",
		dropEffect: "",
	};
	fireEvent.dragStart(source, { dataTransfer });
	return { dataTransfer };
}

test("dropping a document on a folder row confirms the unchanged filename and uses its document ETag", async () => {
	const p = fixture();
	render(<ManagedLibrary {...p} />);
	const table = within(screen.getByRole("table"));
	const source = table.getByRole("button", { name: "文書.md" });
	const target = table.getByRole("row", { name: /空/ });
	expect(source).toHaveAttribute("draggable", "true");
	const drag = startMove(source);
	fireEvent.dragOver(target, drag);
	expect(target).toHaveAttribute("data-move-target", "true");
	fireEvent.dragEnd(source, drag);
	expect(target).not.toHaveAttribute("data-move-target");
	fireEvent.drop(target, drag);
	expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
	fireEvent.drop(target, startMove(source));
	const dialog = screen.getByRole("dialog", { name: "移動" });
	expect(within(dialog).getByLabelText("保存場所")).toHaveValue("空/文書.md");
	expect(p.onManage).not.toHaveBeenCalled();
	await userEvent.click(
		within(dialog).getByRole("button", { name: "キャンセル" }),
	);
	expect(p.onManage).not.toHaveBeenCalled();
	fireEvent.drop(target, startMove(source));
	await userEvent.click(screen.getByRole("button", { name: "移動する" }));
	expect(p.onManage).toHaveBeenCalledExactlyOnceWith(
		{
			op: "patch",
			kind: "document",
			id: doc,
			namespace: "eumenes",
			etag,
			path: "空/文書.md",
		},
		expect.any(String),
	);
});

test("dragging a checked document to the root breadcrumb moves all checked items with the library ETag", async () => {
	const p = fixture();
	const second = "wiki-" + "2".repeat(32);
	p.files = {
		...p.files!,
		path: "書類",
		entries: [
			{ ...p.files!.entries[1]!, path: "書類/文書.md" },
			{ ...p.files!.entries[1]!, id: second, path: "書類/別.markdown" },
		],
	};
	render(<ManagedLibrary {...p} />);
	await userEvent.click(
		screen.getByRole("checkbox", { name: "表示中をすべて選択" }),
	);
	const source = screen.getByRole("button", { name: "文書.md" });
	const root = within(
		screen.getByRole("navigation", { name: "現在のフォルダ" }),
	).getByRole("button", { name: "ルート" });
	fireEvent.drop(root, startMove(source));
	expect(screen.getByRole("dialog")).toHaveTextContent("書類/別.markdown");
	expect(screen.getByLabelText("保存場所")).toHaveAttribute(
		"placeholder",
		"保存領域のルート",
	);
	await userEvent.click(screen.getByRole("button", { name: "移動する" }));
	expect(p.onManage).toHaveBeenCalledExactlyOnceWith(
		{
			op: "batch",
			namespace: "eumenes",
			etag: libraryTag,
			action: "move",
			items: [
				{ kind: "document", id: doc, path: "文書.md" },
				{ kind: "document", id: second, path: "別.markdown" },
			],
		},
		expect.any(String),
	);
});
test("table sorts visible rows by name, type and JST update date, retaining checked documents", async () => {
	const p = fixture();
	const [dir, document] = p.files!.entries;
	p.files = {
		...p.files!,
		path: "書類",
		entries: [
			{ ...dir!, path: "書類/Z" },
			{ ...document!, path: "書類/A10.md", updatedAt: "2026-11-08T15:00:00Z" },
			{
				...document!,
				id: "wiki-" + "2".repeat(32),
				path: "書類/A2.md",
				updatedAt: "2026-11-08T14:59:00Z",
			},
		],
	};
	render(<ManagedLibrary {...p} />);
	const table = within(screen.getByRole("table"));
	const clickHeader = (name: string) =>
		userEvent.click(table.getByRole("button", { name }));
	const names = () =>
		table
			.getAllByRole("row")
			.slice(1)
			.map((row) => within(row).getByRole("button").textContent);
	const checked = table.getByRole("checkbox", { name: "書類/A10.mdを選択" });
	await userEvent.click(checked);
	await clickHeader("名前 / タイトル");
	expect(names()).toEqual(["A2.md", "A10.md", "Z"]);
	await clickHeader("種別");
	expect(table.getAllByRole("cell", { name: "md" })).toHaveLength(2);
	expect(names().at(-1)).toBe("Z");
	await clickHeader("種別");
	expect(names()[0]).toBe("Z");
	await clickHeader("最終更新日");
	expect(names()).toEqual(["A2.md", "A10.md", "Z"]);
	expect(table.getByRole("cell", { name: "2026/11/09" })).toBeInTheDocument();
	expect(table.getByRole("cell", { name: "—" })).toBeInTheDocument();
	await clickHeader("最終更新日");
	expect(names()).toEqual(["A10.md", "A2.md", "Z"]);
	expect(
		table.getByRole("columnheader", { name: "最終更新日" }),
	).toHaveAttribute("aria-sort", "descending");
	expect(table.queryByText("保存済み")).not.toBeInTheDocument();
	expect(checked).toBeChecked();
	await userEvent.click(
		within(
			screen.getByRole("navigation", { name: "現在のフォルダ" }),
		).getByRole("button", { name: "ルート" }),
	);
	expect(p.onFiles).toHaveBeenLastCalledWith("eumenes", "");
});

test("tree drops exclude another namespace, the source folder and its descendants", async () => {
	const p = fixture();
	p.namespaces = ["eumenes", "他の保存領域"];
	p.knownFolders!.push({
		...p.knownFolders![0]!,
		id: "folder-" + "e".repeat(32),
		path: "空/子",
	});
	render(<ManagedLibrary {...p} />);
	const tree = within(screen.getByRole("navigation", { name: "フォルダ" }));
	await userEvent.click(tree.getByRole("button", { name: "空を展開" }));
	const source = within(screen.getByRole("table")).getByRole("button", {
		name: "空",
	});
	for (const name of ["空", "子", "他の保存領域", "eumenes"]) {
		fireEvent.drop(tree.getByRole("button", { name }), startMove(source));
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
	}
	expect(p.onManage).not.toHaveBeenCalled();
	await userEvent.click(screen.getByRole("checkbox", { name: "空を選択" }));
	fireEvent.drop(
		tree.getByRole("button", { name: "子" }),
		startMove(screen.getByRole("button", { name: "文書.md" })),
	);
	expect(screen.getByLabelText("保存場所")).toHaveValue("空/子/文書.md");
	expect(screen.getByRole("dialog")).not.toHaveTextContent("配下に文書");
});

test("drops from outside the list and from an outdated library ETag do not open a move", () => {
	const p = fixture();
	const view = render(<ManagedLibrary {...p} />);
	const source = screen.getByRole("button", { name: "文書.md" });
	const target = within(screen.getByRole("table")).getByRole("row", {
		name: /空/,
	});
	fireEvent.drop(target, { dataTransfer: { types: ["Files"] } });
	expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
	const drag = startMove(source);
	view.rerender(<ManagedLibrary {...p} files={{ ...p.files!, etag }} />);
	fireEvent.drop(target, drag);
	expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
	expect(p.onManage).not.toHaveBeenCalled();
});

test("a library without move support does not offer drag sources", () => {
	const p = fixture();
	p.capabilities!.features!.patch = false;
	render(<ManagedLibrary {...p} />);
	const source = screen.getByRole("button", { name: "文書.md" });
	expect(source).not.toHaveAttribute("draggable");
	fireEvent.drop(
		within(screen.getByRole("table")).getByRole("row", { name: /空/ }),
		startMove(source),
	);
	expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
	expect(p.onManage).not.toHaveBeenCalled();
});
test("real empty folders navigate by namespace/path and document rows open the returned ID", async () => {
	const p = fixture();
	render(<ManagedLibrary {...p} />);
	const table = screen.getByRole("table");
	await userEvent.click(within(table).getByRole("button", { name: "空" }));
	expect(p.onFiles).toHaveBeenCalledWith("eumenes", "空");
	await userEvent.click(within(table).getByRole("button", { name: "文書.md" }));
	expect(p.onEditRemote).toHaveBeenCalledWith(doc);
});
test("rename separates file name and title and submits the document ETag after confirmation", async () => {
	const p = fixture();
	render(<ManagedLibrary {...p} />);
	await userEvent.click(
		screen.getByRole("checkbox", { name: "文書.mdを選択" }),
	);
	await userEvent.click(screen.getByRole("button", { name: "名前・タイトル" }));
	const dialog = screen.getByRole("dialog");
	await userEvent.clear(within(dialog).getByLabelText("保存場所"));
	await userEvent.type(
		within(dialog).getByLabelText("保存場所"),
		"整理/改名.md",
	);
	await userEvent.clear(within(dialog).getByLabelText("文書タイトル"));
	await userEvent.type(
		within(dialog).getByLabelText("文書タイトル"),
		"新しい題名",
	);
	expect(p.onManage).not.toHaveBeenCalled();
	await userEvent.click(
		within(dialog).getByRole("button", { name: "変更する" }),
	);
	await waitFor(() =>
		expect(p.onManage).toHaveBeenCalledWith(
			{
				op: "patch",
				kind: "document",
				id: doc,
				namespace: "eumenes",
				etag,
				path: "整理/改名.md",
				title: "新しい題名",
			},
			expect.any(String),
		),
	);
});
test("batch delete confirms the recursive scope and uses the library ETag; cancel never mutates", async () => {
	const p = fixture();
	render(<ManagedLibrary {...p} />);
	await userEvent.click(
		screen.getByRole("checkbox", { name: "表示中をすべて選択" }),
	);
	await userEvent.click(screen.getByRole("button", { name: "削除" }));
	expect(screen.getByRole("dialog")).toHaveTextContent("配下もすべて削除対象");
	await userEvent.click(screen.getByRole("button", { name: "キャンセル" }));
	expect(p.onManage).not.toHaveBeenCalled();
	await userEvent.click(screen.getByRole("button", { name: "削除" }));
	await userEvent.click(screen.getByRole("button", { name: "削除する" }));
	await waitFor(() =>
		expect(p.onManage).toHaveBeenCalledWith(
			expect.objectContaining({
				op: "batch",
				action: "delete",
				etag: libraryTag,
				items: [
					{ kind: "folder", id: folder },
					{ kind: "document", id: doc },
				],
			}),
			expect.any(String),
		),
	);
});
test("copy fixes a new ID and recursive overlapping selections are reduced without losing batch delete semantics", () => {
	const p = fixture(),
		parent = p.files!.entries[0]!,
		child = { ...p.files!.entries[1]!, path: "空/文書.md" };
	expect(selectedRoots([parent, child])).toEqual([parent]);
	const result = makeLibraryCommand({
		action: "delete",
		items: [parent, child],
		namespace: "eumenes",
		etag: libraryTag,
		path: "",
		title: "",
		recursive: false,
		ids: {},
	});
	expect(result).toEqual({
		op: "batch",
		action: "delete",
		namespace: "eumenes",
		etag: libraryTag,
		items: [{ kind: "folder", id: folder }],
	});
	const command = makeLibraryCommand({
		action: "copy",
		items: [child],
		namespace: "eumenes",
		etag: libraryTag,
		path: "別.md",
		title: "",
		recursive: false,
		ids: { [doc]: "wiki-" + "2".repeat(32) },
	});
	expect(command).toMatchObject({
		id: doc,
		newId: "wiki-" + "2".repeat(32),
		etag,
	});
});
test("dirty input requires save/discard/cancel and unknown operations disable mutations", async () => {
	const p = fixture();
	p.current = {
		id: "local",
		sourceId: doc,
		title: "題名",
		revision: 1,
		dirty: false,
		saveState: "saved",
		saveError: null,
		document: {
			formatVersion: 1,
			nodes: [{ type: "p", children: [{ text: "入力" }] }],
			originalMarkdown: null,
		},
		remote: { id: doc, namespace: "eumenes", path: "文書.md", etag },
	};
	p.localInput = true;
	const view = render(<ManagedLibrary {...p} />);
	await userEvent.click(
		screen.getByRole("checkbox", { name: "文書.mdを選択" }),
	);
	await userEvent.click(screen.getByRole("button", { name: "削除" }));
	expect(screen.getByRole("dialog")).toHaveTextContent("未保存の編集");
	await userEvent.click(
		screen.getByRole("button", { name: "編集に戻って保存" }),
	);
	expect(p.onEditLocal).toHaveBeenCalledWith("local");
	expect(p.onManage).not.toHaveBeenCalled();
	const table = within(screen.getByRole("table"));
	fireEvent.drop(
		table.getByRole("row", { name: /空/ }),
		startMove(table.getByRole("button", { name: "文書.md" })),
	);
	expect(screen.getByRole("dialog")).toHaveTextContent("未保存の編集");
	expect(
		screen.queryByRole("button", { name: "移動する" }),
	).not.toBeInTheDocument();
	await userEvent.click(screen.getByRole("button", { name: "キャンセル" }));
	expect(p.onManage).not.toHaveBeenCalled();
	view.rerender(
		<ManagedLibrary
			{...p}
			operations={[
				{
					id: "unknown",
					state: "unknown",
					code: null,
					command: {},
					removedWorkspaceIds: [],
				},
			]}
		/>,
	);
	expect(screen.getByRole("button", { name: "削除" })).toBeDisabled();
	await userEvent.click(screen.getByRole("button", { name: "結果を確認" }));
	expect(p.onCheck).toHaveBeenCalledWith("unknown");
});
test("the current empty folder remains in the hierarchy after its last child is removed", () => {
	const p = fixture();
	p.files = { ...p.files!, path: "空", entries: [] };
	p.knownFolders = [];
	render(<ManagedLibrary {...p} />);
	expect(
		within(screen.getByRole("navigation", { name: "フォルダ" })).getByRole(
			"button",
			{ name: "空" },
		),
	).toBeInTheDocument();
	expect(
		screen.getByText("このフォルダーには項目がありません。"),
	).toBeInTheDocument();
});
test("an interrupted receipt keeps its request ID for result checking without another change request", async () => {
	const p = fixture(),
		perform = vi.fn(async (_command: unknown, _requestId: string) => false);
	p.onManage = perform;
	render(<ManagedLibrary {...p} />);
	await userEvent.click(
		screen.getByRole("checkbox", { name: "文書.mdを選択" }),
	);
	await userEvent.click(screen.getByRole("button", { name: "削除" }));
	await userEvent.click(screen.getByRole("button", { name: "削除する" }));
	await waitFor(() => expect(perform).toHaveBeenCalledTimes(1));
	const requestId = perform.mock.calls[0]![1];
	await userEvent.click(
		within(screen.getByRole("dialog")).getByRole("button", {
			name: "結果を確認",
		}),
	);
	expect(p.onCheck).toHaveBeenCalledWith(requestId);
	expect(perform).toHaveBeenCalledTimes(1);
});
test("recursive deletion stays disabled when only empty-folder deletion is advertised", async () => {
	const p = fixture();
	p.capabilities!.features!.recursiveDelete = false;
	render(<ManagedLibrary {...p} />);
	await userEvent.click(screen.getByRole("checkbox", { name: "空を選択" }));
	await userEvent.click(screen.getByRole("button", { name: "削除" }));
	expect(
		within(screen.getByRole("dialog")).getByRole("checkbox", {
			name: "配下の文書・フォルダーも削除する",
		}),
	).toBeDisabled();
	expect(p.onManage).not.toHaveBeenCalled();
});
