import { useMemo, useState } from "react";
import { Button } from "../Button";
import { ServerDataTable } from "../ServerDataTable";
import type { ColumnDef } from "@tanstack/react-table";
import type {
	SavedProcedure,
	RecordsWorkspaceProps,
	RecordsPage,
} from "./types";

export function SavedProcedures({
	items,
	page,
	busy,
	error,
	onQuery,
	onProcedureState,
	onProcedureDelete,
}: Pick<
	RecordsWorkspaceProps,
	"busy" | "onProcedureState" | "onProcedureDelete" | "onQuery"
> & { items: SavedProcedure[]; page?: RecordsPage; error?: string }) {
	const [confirm, setConfirm] = useState<string | null>(null);
	const columns = useMemo<ColumnDef<SavedProcedure>[]>(
		() => [
			{ id: "signature", header: "手順", accessorFn: (row) => row.label },
			{ id: "state", header: "状態", accessorFn: (row) => row.status },
			{
				id: "successes",
				header: "成功",
				accessorFn: (row) => row.cells?.successes ?? "—",
			},
			{
				id: "failures",
				header: "失敗",
				accessorFn: (row) => row.cells?.failures ?? "—",
			},
			{
				id: "updatedAt",
				header: "更新日時",
				accessorFn: (row) => row.cells?.updatedAt ?? "—",
			},
			{
				id: "actions",
				header: "操作",
				enableSorting: false,
				cell: ({ row }) => (
					<div className="ds-records-actions">
						<Button
							variant="secondary"
							size="sm"
							disabled={busy}
							onClick={() => onProcedureState(row.id, !row.original.enabled)}
						>
							{row.original.enabled ? "無効にする" : "有効にする"}
						</Button>
						<Button
							variant="secondary"
							size="sm"
							disabled={busy}
							onClick={() => setConfirm(row.id)}
						>
							削除
						</Button>
					</div>
				),
			},
		],
		[busy, onProcedureState],
	);
	const target = items.find((item) => item.id === confirm);
	const current = page ?? {
		query: { pageIndex: 0, pageSize: 10, sort: "updatedAt", desc: true, q: "" },
		total: items.length,
	};
	return (
		<>
			<ServerDataTable
				emptyMessage="保存済みの取得手順はありません。"
				label="取得手順"
				rows={items}
				columns={columns}
				query={current.query}
				total={current.total}
				busy={busy}
				error={error}
				onQuery={(query) => onQuery("procedures", query)}
				detail={(item) => (
					<>
						{item.url && (
							<a href={item.url} target="_blank" rel="noopener noreferrer">
								{item.url}
							</a>
						)}
						<p>{item.description}</p>
					</>
				)}
			/>
			{target && (
				<div role="group" aria-label="取得手順の削除確認">
					<p>「{target.label}」を削除しますか？</p>
					<div className="ds-records-actions">
						<Button
							disabled={busy}
							onClick={() => {
								onProcedureDelete(target.id);
								setConfirm(null);
							}}
						>
							削除する
						</Button>
						<Button
							variant="secondary"
							disabled={busy}
							onClick={() => setConfirm(null)}
						>
							キャンセル
						</Button>
					</div>
				</div>
			)}
		</>
	);
}
