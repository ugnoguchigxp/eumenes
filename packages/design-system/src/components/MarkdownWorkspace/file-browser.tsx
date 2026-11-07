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
import type { MarkdownCurrent, MarkdownWorkspaceProps } from "./types";
import "./file-browser.css";

function fileState(current: MarkdownCurrent | null, localInput: boolean) {
	if (!current) return "作業用";
	if (current.saveState === "saving") return "保存中";
	if (current.saveState === "unknown") return "保存結果不明";
	if (current.saveState === "conflict") return "競合あり";
	return current.dirty || localInput ? "未保存の変更あり" : "保存済み";
}
export function MarkdownFileBrowser(
	props: MarkdownWorkspaceProps & {
		localInput: boolean;
		onEditLocal(id: string): void;
		onEditRemote(id: string): void;
	},
) {
	const folders = useMemo(
		() => documentFolders(props.library, props.namespaces ?? []),
		[props.library, props.namespaces],
	);
	const [selection, setSelection] = useState<
		FolderLocation | "work" | "root" | null
	>(null);
	const [query, setQuery] = useState("");
	const selected = selection ?? (folders.length === 1 ? folders[0]! : "root");
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
		setSelection(value);
		setQuery("");
	}
	return (
		<div className="ds-markdown-file-browser">
			<FolderNavigation
				folders={folders}
				selected={selected}
				onSelect={navigate}
			/>
			<section className="ds-markdown-file-main" aria-label="ファイル一覧">
				<nav className="ds-markdown-breadcrumb" aria-label="現在のフォルダ">
					<button onClick={() => navigate("root")}>Docling</button>
					{work ? (
						<>
							<ChevronRight size={14} />
							<span>作業用の文書</span>
						</>
					) : (
						location && (
							<>
								<ChevronRight size={14} />
								<button
									onClick={() =>
										navigate({ namespace: location.namespace, path: "" })
									}
								>
									{location.namespace}
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
								onChange={(e) => setQuery(e.target.value)}
							/>
						</label>
						<button
							aria-label="ファイル一覧を更新"
							title="ファイル一覧を更新"
							disabled={props.pending || loading}
							onClick={props.onLibrary}
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
								<th scope="col">名前</th>
								<th scope="col">種類</th>
								<th scope="col">保存状態</th>
							</tr>
						</thead>
						<tbody>
							{visibleFolders.map((folder) => (
								<tr key={folder.key}>
									<td>
										<button
											className="ds-markdown-file-name"
											onClick={() => navigate(folder)}
										>
											<Folder size={20} className="ds-markdown-folder-icon" />
											<span>{folder.name}</span>
										</button>
									</td>
									<td>フォルダ</td>
									<td>—</td>
								</tr>
							))}
							{files.map((file) => (
								<tr key={file.sourceId}>
									<td>
										<button
											className="ds-markdown-file-name"
											disabled={props.pending}
											onClick={() => props.onEditRemote(file.sourceId)}
										>
											<FileText size={20} />
											<span>{file.title}</span>
										</button>
										{searching && (
											<small>
												{file.namespace}
												{parentPath(file.path)
													? "/" + parentPath(file.path)
													: ""}
											</small>
										)}
									</td>
									<td>Markdown</td>
									<td>
										<span
											className="ds-markdown-file-state"
											data-saved={
												props.current?.sourceId !== file.sourceId ||
												(!props.current.dirty &&
													!props.localInput &&
													props.current.saveState === "saved")
											}
										>
											<i />
											{props.current?.sourceId === file.sourceId
												? fileState(props.current, props.localInput)
												: "保存済み"}
										</span>
									</td>
								</tr>
							))}
							{documents.map((doc) => (
								<tr key={doc.id}>
									<td>
										<button
											className="ds-markdown-file-name"
											disabled={props.pending}
											onClick={() => props.onEditLocal(doc.id)}
										>
											<PencilLine size={19} />
											<span>{doc.title}</span>
										</button>
									</td>
									<td>作業用文書</td>
									<td>
										{props.current?.id === doc.id
											? fileState(props.current, props.localInput)
											: "作業用"}
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
								onClick={props.onMore}
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
