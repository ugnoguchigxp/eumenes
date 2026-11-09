import { useState } from "react";
import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react";

type Column = "name" | "kind" | "updatedAt";
type RowFields = { name: string; kind: string; updatedAt?: string | number };
const names = new Intl.Collator("ja", { numeric: true });
const dates = new Intl.DateTimeFormat("ja-JP", {
	timeZone: "Asia/Tokyo",
	year: "numeric",
	month: "2-digit",
	day: "2-digit",
});

export function useFileSort() {
	const [state, setState] = useState<{ column: Column; descending: boolean }>();
	return {
		state,
		select(column: Column) {
			setState((previous) => ({
				column,
				descending: previous?.column === column && !previous.descending,
			}));
		},
		rows<T>(items: T[], fields: (item: T) => RowFields) {
			if (!state) return items;
			const { column, descending } = state;
			return [...items].sort((left, right) => {
				const a = fields(left),
					b = fields(right);
				let comparison: number;
				if (column === "updatedAt") {
					const x = new Date(a.updatedAt ?? NaN).getTime(),
						y = new Date(b.updatedAt ?? NaN).getTime();
					if (!Number.isFinite(x)) return Number.isFinite(y) ? 1 : 0;
					if (!Number.isFinite(y)) return -1;
					comparison = x - y;
				} else {
					comparison = names.compare(a[column], b[column]);
				}
				return descending ? -comparison : comparison;
			});
		},
	};
}

const columnLabels: Record<Column, string> = {
	name: "名前 / タイトル",
	kind: "種別",
	updatedAt: "最終更新日",
};

export function FileSortColumn({
	column,
	sort,
}: {
	column: Column;
	sort: ReturnType<typeof useFileSort>;
}) {
	const order =
		sort.state?.column === column
			? sort.state.descending
				? "descending"
				: "ascending"
			: undefined;
	const Icon =
		order === "ascending"
			? ArrowUp
			: order === "descending"
				? ArrowDown
				: ChevronsUpDown;
	return (
		<th className="ds-markdown-sort-column" scope="col" aria-sort={order}>
			<button
				type="button"
				className="ds-markdown-file-sort"
				onClick={() => sort.select(column)}
			>
				{columnLabels[column]}
				<Icon size={14} aria-hidden="true" />
			</button>
		</th>
	);
}

export function FileUpdatedDate({ value }: { value?: string | number }) {
	const date = new Date(value ?? NaN);
	return Number.isFinite(date.getTime()) ? (
		<time dateTime={date.toISOString()}>{dates.format(date)}</time>
	) : (
		<>—</>
	);
}
