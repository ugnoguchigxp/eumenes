import { useEffect, useRef, useState } from "react";
import {
	flexRender,
	getCoreRowModel,
	useReactTable,
	type ColumnDef,
	type SortingState,
} from "@tanstack/react-table";
import { Button } from "../Button";
import { Modal } from "../Modal";
import type { ReactNode } from "react";
import "./ServerDataTable.css";

export type TableQuery = {
	pageIndex: number;
	pageSize: number;
	sort: string;
	desc: boolean;
	q: string;
};
export type ServerDataTableProps<T extends { id: string }> = {
	label: string;
	rows: T[];
	columns: ColumnDef<T>[];
	query: TableQuery;
	total: number;
	busy?: boolean;
	error?: string;
	onQuery: (query: TableQuery) => void;
	detail?: (row: T) => ReactNode;
	detailMode?: "inline" | "modal";
	emptyMessage?: string;
	searchable?: boolean;
	paginated?: boolean;
};
/** All sorting, filtering and pagination are controlled by the caller's API response. */
export function ServerDataTable<T extends { id: string }>({
	label,
	rows,
	columns,
	query,
	total,
	busy,
	error,
	onQuery,
	detail,
	detailMode = "inline",
	emptyMessage = "記録はまだありません。",
	searchable = true,
	paginated = true,
}: ServerDataTableProps<T>) {
	const [search, setSearch] = useState(query.q);
	const [open, setOpen] = useState<string | null>(null);
	const detailTrigger = useRef<HTMLButtonElement | null>(null);
	const sorting: SortingState = [{ id: query.sort, desc: query.desc }];
	// oxlint-disable-next-line react/incompatible-library -- TanStack Table returns unmemoizable functions; nothing here depends on their identity
	const table = useReactTable({
		data: rows,
		columns,
		getRowId: (row) => row.id,
		getCoreRowModel: getCoreRowModel(),
		manualSorting: true,
		manualFiltering: true,
		manualPagination: true,
		rowCount: total,
		enableSortingRemoval: false,
		enableMultiSort: false,
		state: {
			sorting,
			pagination: { pageIndex: query.pageIndex, pageSize: query.pageSize },
		},
		onSortingChange: (update) => {
			const next = typeof update === "function" ? update(sorting) : update;
			if (next[0])
				onQuery({
					...query,
					pageIndex: 0,
					sort: next[0].id,
					desc: next[0].desc,
				});
		},
		onPaginationChange: (update) => {
			const before = { pageIndex: query.pageIndex, pageSize: query.pageSize };
			const next = typeof update === "function" ? update(before) : update;
			onQuery({
				...query,
				...next,
				pageIndex: next.pageSize !== query.pageSize ? 0 : next.pageIndex,
			});
		},
	});
	const visibleDetail = rows.find((row) => row.id === open);
	useEffect(() => {
		if (detailMode === "modal" && open !== null && !visibleDetail)
			setOpen(null);
	}, [detailMode, open, visibleDetail]);
	const pageCount = Math.max(1, table.getPageCount());
	return (
		<section className="ds-server-table" aria-label={label}>
			{searchable && (
				<form
					className="ds-server-table-tools"
					onSubmit={(event) => {
						event.preventDefault();
						onQuery({ ...query, q: search.trim(), pageIndex: 0 });
					}}
				>
					<input
						type="search"
						aria-label={`${label}を検索`}
						placeholder="検索する文字を入力"
						value={search}
						maxLength={200}
						onChange={(event) => setSearch(event.target.value)}
					/>
					<Button variant="secondary" disabled={busy} type="submit">
						検索
					</Button>
					{query.q && (
						<Button
							variant="ghost"
							disabled={busy}
							type="button"
							onClick={() => {
								setSearch("");
								onQuery({ ...query, q: "", pageIndex: 0 });
							}}
						>
							検索を解除
						</Button>
					)}
				</form>
			)}
			{error && <p role="alert">{error}</p>}
			<div
				className="ds-server-table-scroll"
				role="region"
				aria-label={`${label}の表`}
				// oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- scrollable or keyboard-reachable region needs to take focus
				tabIndex={0}
				aria-busy={busy}
			>
				<table>
					<caption className="sr-only">{label}</caption>
					<thead>
						{table.getHeaderGroups().map((group) => (
							<tr key={group.id}>
								{group.headers.map((header) => (
									<th
										key={header.id}
										scope="col"
										aria-sort={
											header.column.getIsSorted() === "asc"
												? "ascending"
												: header.column.getIsSorted() === "desc"
													? "descending"
													: undefined
										}
									>
										{header.column.getCanSort() ? (
											<button
												type="button"
												disabled={busy}
												onClick={header.column.getToggleSortingHandler()}
											>
												{flexRender(
													header.column.columnDef.header,
													header.getContext(),
												)}
												<span aria-hidden="true">
													{header.column.getIsSorted() === "asc"
														? " ↑"
														: header.column.getIsSorted() === "desc"
															? " ↓"
															: " ↕"}
												</span>
											</button>
										) : (
											flexRender(
												header.column.columnDef.header,
												header.getContext(),
											)
										)}
									</th>
								))}
								{detail && <th scope="col">詳細</th>}
							</tr>
						))}
					</thead>
					<tbody>
						{table.getRowModel().rows.map((row) => (
							<tr key={row.id}>
								{row.getVisibleCells().map((cell) => (
									<td key={cell.id} data-column={cell.column.id}>
										{flexRender(cell.column.columnDef.cell, cell.getContext())}
									</td>
								))}
								{detail && (
									<td>
										<Button
											variant="ghost"
											size="sm"
											aria-expanded={
												detailMode === "inline" ? row.id === open : undefined
											}
											aria-haspopup={
												detailMode === "modal" ? "dialog" : undefined
											}
											aria-label={`${label}: ${row.id}の詳細`}
											onClick={(event) => {
												detailTrigger.current = event.currentTarget;
												setOpen(open === row.id ? null : row.id);
											}}
										>
											詳細
										</Button>
									</td>
								)}
							</tr>
						))}
					</tbody>
				</table>
			</div>
			{busy && <p role="status">読み込み中…</p>}
			{!busy && !error && !total && (
				<p>{query.q ? "検索条件に一致する記録はありません。" : emptyMessage}</p>
			)}
			{paginated && (
				<div className="ds-server-table-tools">
					<label>
						表示件数{" "}
						<select
							aria-label={`${label}の表示件数`}
							value={query.pageSize}
							disabled={busy}
							onChange={(event) =>
								table.setPageSize(Number(event.target.value))
							}
						>
							{[10, 25, 50].map((size) => (
								<option key={size} value={size}>
									{size}件
								</option>
							))}
						</select>
					</label>
					<span aria-live="polite">
						{busy
							? "取得中…"
							: `${total}件 · ${query.pageIndex + 1} / ${pageCount}ページ`}
					</span>
					<Button
						variant="secondary"
						disabled={busy || !table.getCanPreviousPage()}
						aria-label={`${label}の前のページ`}
						onClick={() => table.previousPage()}
					>
						前へ
					</Button>
					<Button
						variant="secondary"
						disabled={busy || !table.getCanNextPage()}
						aria-label={`${label}の次のページ`}
						onClick={() => table.nextPage()}
					>
						次へ
					</Button>
				</div>
			)}
			{detail && visibleDetail && detailMode === "inline" && (
				<div className="ds-server-table-detail">
					<div className="ds-server-table-tools">
						<strong>選択した行の詳細</strong>
						<Button variant="ghost" onClick={() => setOpen(null)}>
							詳細を閉じる
						</Button>
					</div>
					{detail(visibleDetail)}
				</div>
			)}
			{detail && detailMode === "modal" && (
				<Modal
					open={!!visibleDetail}
					onOpenChange={(isOpen) => {
						if (!isOpen) setOpen(null);
					}}
					onCloseAutoFocus={(event) => {
						event.preventDefault();
						if (detailTrigger.current?.isConnected)
							detailTrigger.current.focus();
					}}
					title={`${label}の詳細`}
					contentClassName="ds-server-table-modal"
					draggable={false}
				>
					{visibleDetail && detail(visibleDetail)}
				</Modal>
			)}
		</section>
	);
}
