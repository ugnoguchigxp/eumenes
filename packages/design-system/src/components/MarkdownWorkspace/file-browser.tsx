import { ManagedLibrary } from "./managed-library";
import { useMemo, useState } from "react";
import {
	ChevronRight,
	FileText,
	Folder,
	FolderOpen,
	PencilLine,
	RefreshCw,
	Search,
} from "lucide-react";
import {
	documentFolders,
	findFolder,
	folderFiles,
	parentPath,
	type FolderLocation,
} from "./file-tree";
import { FolderNavigation } from "./folder-navigation";
import type { MarkdownWorkspaceProps } from "./types";
import type { HeaderDeleteSelection } from "./library-types";
import {
	useLibraryReveal,
	type RevealRequest,
	type RevealedDocument,
} from "./library-reveal";
import {
	FileSortColumn,
	FileUpdatedDate,
	useFileSort,
} from "./file-list-columns";
import "./file-browser.css";

type FileBrowserProps = MarkdownWorkspaceProps & {
	headerDelete?: HeaderDeleteSelection;
	localInput: boolean;
	onDiscardCurrent?(): Promise<boolean>;
	onEditLocal(id: string): void;
	onEditRemote(id: string): void;
};
export function MarkdownFileBrowser(
	props: FileBrowserProps & { reveal?: RevealRequest },
) {
	const [ignored, setIgnored] = useState<RevealRequest>();
	const reveal = useLibraryReveal(
		props,
		ignored === props.reveal ? undefined : props.reveal,
	);
	const onBrowse = () => setIgnored(props.reveal);
	if (props.capabilities?.features?.library) {
		const files = props.files;
		const folder =
			typeof reveal?.location === "object" ? reveal.location : undefined;
		const matches =
			!folder ||
			(files?.namespace === folder.namespace && files.path === folder.path);
		return (
			<ManagedLibrary
				key={JSON.stringify([files?.namespace, files?.path, files?.etag])}
				{...props}
				files={matches ? files : undefined}
				reveal={reveal}
				onBrowse={onBrowse}
			/>
		);
	}
	return <LegacyLibrary {...props} reveal={reveal} onBrowse={onBrowse} />;
}

function LegacyLibrary(
	props: FileBrowserProps & { reveal?: RevealedDocument; onBrowse(): void },
) {
	const { reveal } = props;
	const revealFolder =
		typeof reveal?.location === "object" ? reveal.location : undefined;
	const folders = useMemo(
		() =>
			documentFolders(
				props.library,
				props.namespaces ?? [],
				revealFolder?.path ? [revealFolder] : [],
			),
		[props.library, props.namespaces, revealFolder],
	);
	const [selection, setSelection] = useState<
		FolderLocation | "work" | "root" | null
	>(null);
	const [search, setQuery] = useState("");
	const query = reveal ? "" : search;
	const selected =
		reveal?.location ??
		selection ??
		(folders.length === 1 ? folders[0]! : "root");
	const location = typeof selected === "object" ? selected : null;
	const currentFolder = location ? findFolder(folders, location) : null;
	const work = selected === "work",
		searching = !!query;
	const visibleFolders =
		work || searching
			? []
			: selected === "root"
				? folders
				: (currentFolder?.children ?? []);
	const files =
		work || (selected === "root" && !searching)
			? []
			: folderFiles(props.library, location, query);
	const documents = work
		? props.documents.filter((d) =>
				d.title.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
			)
		: [];
	const loading =
		props.libraryStatus === "idle" || props.libraryStatus === "loading";
	const count = visibleFolders.length + files.length + documents.length;
	const title = work
		? "作業用の文書"
		: location
			? (currentFolder?.name ??
				location.path.split("/").at(-1) ??
				location.namespace)
			: "Docling";
	function navigate(value: FolderLocation | "work" | "root") {
		props.onBrowse();
		setSelection(value);
		setQuery("");
	}
	const sort = useFileSort();
	const rows: {
		id: string;
		name: string;
		kind: "md" | "フォルダー";
		Icon: typeof FileText;
		current?: boolean;
		updatedAt?: string | number;
		detail?: string;
		open(): void;
	}[] = [
		...visibleFolders.map((folder) => ({
			id: folder.key,
			name: folder.name,
			kind: "フォルダー" as const,
			Icon: Folder,
			open: () => navigate(folder),
		})),
		...files.map((file) => ({
			id: file.sourceId,
			name: file.title,
			kind: "md" as const,
			Icon: FileText,
			current: props.current?.sourceId === file.sourceId,
			updatedAt: file.updatedAt,
			detail: searching
				? [file.namespace, parentPath(file.path)].filter(Boolean).join("/")
				: undefined,
			open: () => props.onEditRemote(file.sourceId),
		})),
		...documents.map((doc) => ({
			id: doc.id,
			name: doc.title,
			kind: "md" as const,
			Icon: PencilLine,
			current: props.current?.id === doc.id,
			updatedAt: doc.updated_at,
			open: () => props.onEditLocal(doc.id),
		})),
	];
	return (
		<div className="ds-markdown-file-browser">
			<FolderNavigation
				folders={folders}
				selected={selected}
				onSelect={navigate}
			/>
			<section className="ds-markdown-file-main" aria-label="ファイル一覧">
				<nav className="ds-markdown-breadcrumb" aria-label="現在のフォルダ">
					{location ? (
						<button onClick={() => navigate("root")}>Docling</button>
					) : (
						<>
							<span>Docling</span>
							<button onClick={() => navigate("root")}>ルート</button>
						</>
					)}
					{work ? (
						<>
							<ChevronRight size={14} />
							<span>作業用の文書</span>
						</>
					) : (
						location && (
							<>
								<ChevronRight size={14} />
								<span>{location.namespace}</span>
								<button
									onClick={() =>
										navigate({ namespace: location.namespace, path: "" })
									}
								>
									ルート
								</button>
								{location.path
									.split("/")
									.filter(Boolean)
									.map((name, index, parts) => (
										<span key={parts.slice(0, index + 1).join("/")}>
											<ChevronRight size={14} />
											<button
												onClick={() =>
													navigate({
														namespace: location.namespace,
														path: parts.slice(0, index + 1).join("/"),
													})
												}
											>
												{name}
											</button>
										</span>
									))}
							</>
						)
					)}
				</nav>
				<div className="ds-markdown-file-heading">
					<div>
						<h2>{title}</h2>
						<span>
							{count}項目{searching ? "・検索結果" : ""}
						</span>
					</div>
					<div className="ds-markdown-file-tools">
						<label>
							<Search size={16} />
							<input
								type="search"
								aria-label="文書名・パスで検索"
								placeholder="文書名・パスで検索"
								value={query}
								onChange={(e) => {
									if (reveal) navigate(selected);
									setQuery(e.target.value);
								}}
							/>
						</label>
						<button
							aria-label="ファイル一覧を更新"
							title="ファイル一覧を更新"
							disabled={props.pending || loading}
							onClick={() => {
								if (reveal) navigate(selected);
								props.onLibrary();
							}}
						>
							<RefreshCw size={17} />
						</button>
					</div>
				</div>
				{!work && loading && <p role="status">文書を読み込んでいます…</p>}
				{!work && props.libraryStatus === "error" && (
					<div role="alert" className="ds-markdown-file-error">
						一覧を読み込めませんでした。更新すると再試行できます。
					</div>
				)}
				<div className="ds-markdown-file-table-wrap">
					<table
						className="ds-markdown-file-table"
						aria-label={work ? "作業用文書の一覧" : "保存文書の一覧"}
					>
						<thead>
							<tr>
								<FileSortColumn column="name" sort={sort} />
								<FileSortColumn column="kind" sort={sort} />
								<FileSortColumn column="updatedAt" sort={sort} />
							</tr>
						</thead>
						<tbody>
							{sort
								.rows(rows, (row) => row)
								.map((row) => (
									<tr key={row.id} data-current={row.current || undefined}>
										<td>
											<button
												className="ds-markdown-file-name"
												aria-current={row.current || undefined}
												ref={reveal?.id === row.id ? reveal.button : undefined}
												disabled={props.pending && row.kind === "md"}
												onClick={row.open}
											>
												<row.Icon
													size={20}
													className={
														row.kind === "フォルダー"
															? "ds-markdown-folder-icon"
															: undefined
													}
												/>
												<span>{row.name}</span>
											</button>
											{row.detail && <small>{row.detail}</small>}
										</td>
										<td>{row.kind}</td>
										<td className="ds-markdown-file-date">
											<FileUpdatedDate value={row.updatedAt} />
										</td>
									</tr>
								))}
						</tbody>
					</table>
				</div>
				{!count && !loading && props.libraryStatus !== "error" && (
					<div className="ds-markdown-files-empty">
						<FolderOpen size={32} />
						<p>
							{searching
								? "一致する文書がありません。"
								: work
									? "作業用の文書はまだありません。"
									: "このフォルダには文書がありません。"}
						</p>
					</div>
				)}
				<footer className="ds-markdown-file-footer">
					{!work && props.libraryHasMore && (
						<>
							<span>読み込み済みの文書とフォルダを表示しています。</span>
							<button
								disabled={props.pending || loading}
								onClick={() => {
									if (reveal) navigate(selected);
									props.onMore?.();
								}}
							>
								続きを読み込む
							</button>
						</>
					)}
					<small>文書を開くと編集ビューに切り替わります。</small>
				</footer>
			</section>
		</div>
	);
}
