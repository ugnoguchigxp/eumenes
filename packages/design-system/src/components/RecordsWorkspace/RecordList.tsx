import { Fragment, useMemo } from "react";
import { ServerDataTable, type TableQuery } from "../ServerDataTable";
import type { RecordRow, RecordsTab } from "./types";
import type { ColumnDef } from "@tanstack/react-table";

export function RecordList({
	tab,
	busy,
	onQuery,
}: {
	tab: RecordsTab;
	busy?: boolean;
	onQuery: (query: TableQuery) => void;
}) {
	const columns = useMemo<ColumnDef<RecordRow>[]>(
		() =>
			(tab.columns ?? [{ id: "label", label: "項目" }]).map((col) => ({
				id: col.id,
				header: col.label,
				accessorFn: (row) => row.cells?.[col.id] ?? row.label,
			})),
		[tab.columns],
	);
	const page = tab.page ?? {
		query: { pageIndex: 0, pageSize: 10, sort: "label", desc: false, q: "" },
		total: tab.rows.length,
	};
	return (
		<ServerDataTable
			label={tab.label}
			rows={tab.rows}
			columns={columns}
			query={page.query}
			total={page.total}
			busy={busy || tab.loading}
			error={tab.error}
			onQuery={onQuery}
			detail={(row) => (
				<>
					<dl>
						{row.details.map((item) => (
							<Fragment key={item.label}>
								<dt>{item.label}</dt>
								<dd>{item.value}</dd>
							</Fragment>
						))}
					</dl>
					{row.table && (
						<div className="ds-records-table">
							<table>
								<caption>{row.table.title}</caption>
								<thead>
									<tr>
										{row.table.columns.map((col) => (
											<th key={col}>{col}</th>
										))}
									</tr>
								</thead>
								<tbody>
									{row.table.rows.map((cells, i) => (
										<tr key={i}>
											{cells.map((cell, j) => (
												<td key={j}>{cell}</td>
											))}
										</tr>
									))}
								</tbody>
							</table>
						</div>
					)}
				</>
			)}
		/>
	);
}
