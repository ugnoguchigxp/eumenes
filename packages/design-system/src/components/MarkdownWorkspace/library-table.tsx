import type { Dispatch, SetStateAction } from "react";
import { Folder, FileText } from "lucide-react";
import type { MarkdownWorkspaceProps } from "./types";
import type { LibraryItem } from "./library-types";
import type { LibraryMoveDrag } from "./library-move-drag";
import type { RevealedDocument } from "./library-reveal";
import {
	FileSortColumn,
	FileUpdatedDate,
	useFileSort,
} from "./file-list-columns";
export function ManagedLibraryTable(
	props: MarkdownWorkspaceProps & {
		work: boolean;
		query: string;
		visible: LibraryItem[];
		selection: string[];
		setSelection: Dispatch<SetStateAction<string[]>>;
		pending?: boolean;
		moveDrag?: LibraryMoveDrag;
		reveal?: RevealedDocument;
		limit: number;
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
	const sort = useFileSort();
	const items = sort.rows(visible, (e) => ({
		name: e.path.split("/").at(-1) ?? e.path,
		kind: e.kind === "folder" ? "フォルダー" : "md",
		updatedAt: e.updatedAt,
	}));
	const documents = sort.rows(
		props.documents.filter((d) => d.title.includes(query)),
		(d) => ({ name: d.title, kind: "md", updatedAt: d.updated_at }),
	);
	return (
		<>
			{work ? (
				<table className="ds-markdown-file-table" aria-label="作業用文書の一覧">
					<thead>
						<tr>
							<FileSortColumn column="name" sort={sort} />
							<FileSortColumn column="kind" sort={sort} />
							<FileSortColumn column="updatedAt" sort={sort} />
						</tr>
					</thead>
					<tbody>
						{documents.map((d) => (
							<tr
								key={d.id}
								data-current={props.current?.id === d.id || undefined}
							>
								<td>
									<button
										className="ds-markdown-file-name"
										aria-current={props.current?.id === d.id || undefined}
										ref={
											props.reveal?.id === d.id
												? props.reveal.button
												: undefined
										}
										onClick={() => props.onEditLocal(d.id)}
									>
										{d.title}
									</button>
								</td>
								<td>md</td>
								<td className="ds-markdown-file-date">
									<FileUpdatedDate value={d.updated_at} />
								</td>
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
								<FileSortColumn column="name" sort={sort} />
								<FileSortColumn column="kind" sort={sort} />
								<FileSortColumn column="updatedAt" sort={sort} />
							</tr>
						</thead>
						<tbody>
							{items.map((e) => (
								<tr
									key={e.id}
									{...(e.kind === "folder" && props.moveDrag?.target(e))}
									data-selected={selection.includes(e.id) || undefined}
									data-current={props.current?.sourceId === e.id || undefined}
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
											{...props.moveDrag?.source(e)}
											aria-current={
												props.current?.sourceId === e.id || undefined
											}
											ref={
												props.reveal?.id === e.id
													? props.reveal.button
													: undefined
											}
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
										{e.kind === "folder" && (
											<small>
												{e.hasUnsupportedEntries
													? "操作対象外の項目を含む"
													: `${e.documentCount}文書・${e.folderCount}フォルダー`}
											</small>
										)}
									</td>
									<td>{e.kind === "folder" ? "フォルダー" : "md"}</td>
									<td className="ds-markdown-file-date">
										<FileUpdatedDate value={e.updatedAt} />
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
