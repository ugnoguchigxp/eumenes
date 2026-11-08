import { afterEach, expect, test, vi } from "vitest";
import {
	cleanup,
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
