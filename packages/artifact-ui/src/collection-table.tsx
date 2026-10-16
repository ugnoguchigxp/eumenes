import {
	ServerDataTable,
	type ServerDataTableProps,
	type TableQuery,
} from "@eumenes/design-system";
import { useState } from "react";
import type { CollectionResource, CollectionRow } from "./collection-contracts";

/** The same table supports a complete loaded collection and an API-paged source. */
export function CollectionTable({
	data,
	onQuery,
	...props
}: Omit<
	ServerDataTableProps<CollectionRow>,
	"rows" | "total" | "query" | "onQuery"
> & {
	data: CollectionResource;
	onQuery: (query: TableQuery) => void;
}) {
	const [localQuery, setLocalQuery] = useState<TableQuery>({
		pageIndex: 0,
		pageSize: 10,
		sort: "",
		desc: false,
		q: "",
	});
	let rows = data.rows;
	let total = data.total;
	let query = data.paging ?? localQuery;
	if (!data.paging) {
		const needle = query.q.toLocaleLowerCase();
		rows = rows.filter((row) =>
			Object.values(row.cells).some((value) =>
				value.toLocaleLowerCase().includes(needle),
			),
		);
		if (query.sort) {
			const { sort, desc } = query;
			rows.sort(
				(a, b) =>
					(a.cells[sort] ?? "").localeCompare(b.cells[sort] ?? "", undefined, {
						numeric: true,
					}) * (desc ? -1 : 1),
			);
		}
		total = rows.length;
		query = {
			...query,
			pageIndex: Math.min(
				query.pageIndex,
				Math.max(0, Math.ceil(total / query.pageSize) - 1),
			),
		};
		rows = rows.slice(
			query.pageIndex * query.pageSize,
			(query.pageIndex + 1) * query.pageSize,
		);
	}
	return (
		<ServerDataTable
			{...props}
			rows={rows}
			total={total}
			query={query}
			onQuery={data.paging ? onQuery : setLocalQuery}
		/>
	);
}
