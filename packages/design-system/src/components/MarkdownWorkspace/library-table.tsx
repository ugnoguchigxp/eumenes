import type { Dispatch, SetStateAction } from "react";
import { Folder, FileText } from "lucide-react";
import type { MarkdownWorkspaceProps } from "./types";
import type { LibraryItem } from "./library-types";
export function ManagedLibraryTable(
	props: MarkdownWorkspaceProps & {
		work: boolean;
		query: string;
		visible: LibraryItem[];
		selection: string[];
		setSelection: Dispatch<SetStateAction<string[]>>;
		pending?: boolean;
		limit: number;
		localInput: boolean;
		changeFolder(namespace: string, path: string): void;
		onEditLocal(id: string): void;
		onEditRemote(id: string): void;
	},
) {
	const {
		work,
		query,
		visible,
		selection,
		setSelection,
		pending,
		limit,
		changeFolder,
	} = props;
	return (
		<>
			{work ? (
				<table className="ds-markdown-file-table" aria-label="作業用文書の一覧">
					<thead>
						<tr>
							<th>名前</th>
							<th>種類</th>
						</tr>
					</thead>
					<tbody>
						{props.documents
							.filter((d) => d.title.includes(query))
							.map((d) => (
								<tr key={d.id}>
									<td>
										<button
											className="ds-markdown-file-name"
											onClick={() => props.onEditLocal(d.id)}
										>
											{d.title}
										</button>
									</td>
									<td>作業用文書</td>
								</tr>
							))}
					</tbody>
				</table>
			) : (
				<div className="ds-markdown-file-table-wrap">
					<table
						className="ds-markdown-file-table ds-markdown-managed-table"
						aria-label="保存文書の一覧"
					>
						<thead>
							<tr>
								<th scope="col">
									<input
										type="checkbox"
										aria-label="表示中をすべて選択"
										checked={
											visible.length > 0 &&
											visible.every((e) => selection.includes(e.id))
										}
										disabled={pending || visible.length > limit}
										onChange={(e) =>
											setSelection(
												e.target.checked ? visible.map((i) => i.id) : [],
											)
										}
									/>
								</th>
								<th scope="col">名前 / タイトル</th>
								<th scope="col">種類</th>
								<th scope="col">内容</th>
							</tr>
						</thead>
						<tbody>
							{visible.map((e) => (
								<tr
									key={e.id}
									data-selected={selection.includes(e.id) || undefined}
								>
									<td>
										<input
											type="checkbox"
											aria-label={`${e.path}を選択`}
											checked={selection.includes(e.id)}
											disabled={
												pending ||
												(!selection.includes(e.id) && selection.length >= limit)
											}
											onChange={(v) =>
												setSelection(
													v.target.checked
														? [...selection, e.id]
														: selection.filter((id) => id !== e.id),
												)
											}
										/>
									</td>
									<td>
										<button
											className="ds-markdown-file-name"
											disabled={pending}
											onClick={() =>
												e.kind === "folder"
													? changeFolder(e.namespace, e.path)
													: props.onEditRemote(e.id)
											}
										>
											{e.kind === "folder" ? (
												<Folder size={20} />
											) : (
												<FileText size={20} />
											)}
											<span>{e.path.split("/").at(-1)}</span>
										</button>
										{e.kind === "document" && e.title && (
											<small>{e.title}</small>
										)}
									</td>
									<td>{e.kind === "folder" ? "フォルダー" : "Markdown"}</td>
									<td>
										{e.kind === "folder"
											? e.hasUnsupportedEntries
												? "操作対象外の項目を含む"
												: `${e.documentCount}文書・${e.folderCount}フォルダー`
											: props.current?.sourceId === e.id &&
												  (props.localInput || props.current.dirty)
												? "未保存の変更あり"
												: "保存済み"}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}
		</>
	);
}
