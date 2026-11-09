import { ManagedLibraryTable } from "./library-table";
import { useMemo, useState } from "react";
import {
	FolderPlus,
	Trash2,
	Copy,
	MoveRight,
	PencilLine,
	RefreshCw,
} from "lucide-react";
import { FolderNavigation } from "./folder-navigation";
import { documentFolders, type FolderLocation } from "./file-tree";
import { LibraryActionDialog } from "./library-action-dialog";
import type { MarkdownWorkspaceProps } from "./types";
import {
	canMoveLibraryItems,
	pathInFolder,
	type LibraryAction,
} from "./library-actions";
import type {
	HeaderDeleteSelection,
	LibraryFiles,
	LibraryItem,
} from "./library-types";
import { useLibraryMoveDrag, type LibraryMoveDrag } from "./library-move-drag";
import type { RevealedDocument } from "./library-reveal";
export function ManagedLibrary(
	props: MarkdownWorkspaceProps & {
		headerDelete?: HeaderDeleteSelection;
		reveal?: RevealedDocument;
		onBrowse?(): void;
		localInput: boolean;
		onEditLocal(id: string): void;
		onEditRemote(id: string): void;
		onDiscardCurrent?(): Promise<boolean>;
	},
) {
	const files = props.files,
		features = props.capabilities!.features!,
		[ownSelection, setOwnSelection] = useState<string[]>([]),
		[search, setQuery] = useState(""),
		[showWork, setWork] = useState(false),
		[action, setAction] = useState<{
			kind: LibraryAction;
			files: LibraryFiles;
			items: LibraryItem[];
			initialPath?: string;
		} | null>(null);
	const work = props.reveal ? props.reveal.location === "work" : showWork;
	const query = props.reveal ? "" : search;
	const location =
		typeof props.reveal?.location === "object" ? props.reveal.location : files;
	const { selection, setSelection } = props.headerDelete ?? {
		selection: ownSelection,
		setSelection: setOwnSelection,
	};
	const folders = useMemo(
		() =>
			documentFolders(
				[],
				[
					...(props.namespaces ?? []),
					...(location ? [location.namespace] : []),
				],
				[...(props.knownFolders ?? []), ...(location?.path ? [location] : [])],
			),
		[props.namespaces, props.knownFolders, location],
	);
	const entries = files?.entries ?? [],
		selected = entries.filter((e) => selection.includes(e.id)),
		pending = props.pending || props.filesLoading,
		uncertain = props.operations?.filter((o) => o.state === "unknown") ?? [];
	const disabled =
			pending ||
			!!uncertain.length ||
			selected.some(
				(e) =>
					e.hasUnsupportedEntries || (e.kind === "folder" && !features.folders),
			),
		visible = entries.filter((e) =>
			(e.path + "\n" + (e.title ?? e.name ?? ""))
				.toLocaleLowerCase()
				.includes(query.toLocaleLowerCase()),
		);
	const moveDrag = useLibraryMoveDrag({
		files,
		features,
		selected,
		disabled: !!(
			pending ||
			uncertain.length ||
			work ||
			action ||
			props.filesError ||
			!props.onManage
		),
		onMove(source, items, destination) {
			setAction({
				kind: "move",
				files: source,
				items,
				initialPath:
					items.length === 1
						? pathInFolder(items[0]!.path, destination)
						: destination,
			});
		},
	});
	const changeFolder = (namespace: string, path: string) => {
		props.onBrowse?.();
		moveDrag.end();
		setWork(false);
		setSelection([]);
		setQuery("");
		props.onFiles?.(namespace, path);
	};
	const buttons: {
		action: LibraryAction;
		label: string;
		Icon: typeof Copy;
		enabled: boolean;
	}[] = [
		{
			action: "create-folder",
			label: "新しいフォルダー",
			Icon: FolderPlus,
			enabled: features.createFolder,
		},
		{
			action: "patch",
			label: "名前・タイトル",
			Icon: PencilLine,
			enabled: features.patch && selected.length === 1,
		},
		{
			action: "move",
			label: "移動",
			Icon: MoveRight,
			enabled: canMoveLibraryItems(selected, features),
		},
		{
			action: "copy",
			label: "コピー",
			Icon: Copy,
			enabled:
				features.copy &&
				(!selected.some((e) => e.kind === "folder") || !!features.folderCopy) &&
				selected.length > 0 &&
				(selected.length === 1 || features.batch),
		},
		{
			action: "delete",
			label: "削除",
			Icon: Trash2,
			enabled:
				features.delete &&
				selected.length > 0 &&
				(selected.length === 1 || features.batch),
		},
	];
	return (
		<div className="ds-markdown-file-browser" onDragEnd={moveDrag.end}>
			<FolderNavigation
				folders={folders}
				dropTarget={moveDrag.target}
				selected={work ? "work" : (location ?? "root")}
				onSelect={(value) => {
					if (value === "work") {
						props.onBrowse?.();
						moveDrag.end();
						setQuery("");
						setWork(true);
						setSelection([]);
						return;
					}
					if (typeof value === "object")
						changeFolder(value.namespace, value.path);
					else if (props.namespaces?.[0]) changeFolder(props.namespaces[0], "");
				}}
			/>
			<section className="ds-markdown-file-main" aria-label="ファイル一覧">
				<LibraryBreadcrumb
					location={
						work && location
							? { namespace: location.namespace, path: "" }
							: location
					}
					dropTarget={moveDrag.target}
					changeFolder={changeFolder}
				/>
				<div className="ds-markdown-file-heading">
					<div>
						<h2>
							{work
								? "作業用の文書"
								: location?.path.split("/").at(-1) ||
									location?.namespace ||
									"文書"}
						</h2>
						<span>
							{work ? props.documents.length : entries.length}項目
							{selection.length > 0 ? `・${selection.length}件選択` : ""}
						</span>
					</div>
					<div className="ds-markdown-file-tools">
						<input
							type="search"
							aria-label="文書名・パスで検索"
							placeholder="このフォルダーで検索"
							value={query}
							onChange={(e) => {
								props.onBrowse?.();
								setWork(work);
								setQuery(e.target.value);
							}}
						/>
						<button
							aria-label="ファイル一覧を更新"
							disabled={pending}
							onClick={() =>
								location
									? changeFolder(location.namespace, location.path)
									: props.namespaces?.[0] &&
										changeFolder(props.namespaces[0], "")
							}
						>
							<RefreshCw size={17} />
						</button>
					</div>
				</div>
				{!work && (
					<div
						className="ds-markdown-management-toolbar"
						aria-label="文書の管理操作"
					>
						{buttons
							.filter((b) => !props.headerDelete || b.action !== "delete")
							.map((b) => (
								<button
									key={b.action}
									disabled={disabled || !b.enabled || !files}
									onClick={() =>
										files &&
										setAction({
											kind: b.action,
											files,
											items: b.action === "create-folder" ? [] : selected,
										})
									}
								>
									<b.Icon size={16} />
									{b.label}
								</button>
							))}
					</div>
				)}
				{props.filesLoading && <p role="status">文書を読み込んでいます…</p>}
				{props.filesError && <p role="alert">{props.filesError}</p>}
				{uncertain.map((o) => (
					<div key={o.id} className="ds-markdown-file-error" role="status">
						管理操作の結果が未確認です。変更要求は再送していません。
						<button disabled={pending} onClick={() => props.onCheck?.(o.id)}>
							結果を確認
						</button>
					</div>
				))}
				<ManagedLibraryTable
					{...props}
					work={work}
					query={query}
					visible={visible}
					selection={selection}
					setSelection={setSelection}
					pending={pending}
					limit={features.maxBatchItems || 100}
					changeFolder={changeFolder}
					moveDrag={moveDrag}
				/>

				{!work &&
					!entries.length &&
					!props.filesLoading &&
					!props.filesError && <p>このフォルダーには項目がありません。</p>}
				{!work && files?.nextCursor && (
					<button
						disabled={pending}
						onClick={() => {
							props.onBrowse?.();
							props.onFiles?.(files.namespace, files.path, files.nextCursor!);
						}}
					>
						続きを読み込む
					</button>
				)}
				{action && (
					<LibraryActionDialog
						{...props}
						files={action.files}
						action={action.kind}
						items={action.items}
						initialPath={action.initialPath}
						onClose={() => setAction(null)}
						onEditCurrent={() => {
							setAction(null);
							if (props.current) props.onEditLocal(props.current.id);
						}}
						onDiscardCurrent={props.onDiscardCurrent}
					/>
				)}
			</section>
		</div>
	);
}

function LibraryBreadcrumb({
	location,
	dropTarget,
	changeFolder,
}: {
	location?: FolderLocation;
	dropTarget: LibraryMoveDrag["target"];
	changeFolder(namespace: string, path: string): void;
}) {
	return (
		<nav className="ds-markdown-breadcrumb" aria-label="現在のフォルダ">
			<span>Docling</span>
			{location && (
				<>
					<span>{location.namespace}</span>
					<button
						{...dropTarget({
							namespace: location.namespace,
							path: "",
						})}
						onClick={() => changeFolder(location.namespace, "")}
					>
						ルート
					</button>
					{location.path
						.split("/")
						.filter(Boolean)
						.map((part, i, parts) => {
							const path = parts.slice(0, i + 1).join("/");
							return (
								<button
									key={path}
									{...dropTarget({
										namespace: location.namespace,
										path,
									})}
									onClick={() => changeFolder(location.namespace, path)}
								>
									/ {part}
								</button>
							);
						})}
				</>
			)}
		</nav>
	);
}
