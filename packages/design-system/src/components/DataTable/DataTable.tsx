import { cn } from "@/utils/cn";

export type DataTableCell = string | number;

export interface DataTableColumn {
	header: string;
	/** Defaults to right for a column of numbers and left otherwise. */
	align?: "left" | "center" | "right";
}

export interface DataTableProps {
	title?: string;
	columns: DataTableColumn[];
	/** One array of cells per row, in column order. The caller cuts long tables. */
	rows: DataTableCell[][];
	/** Rows the caller left out; shown as "他N行". */
	omittedRows?: number;
	/** Formats number cells. Default: grouped digits. */
	formatNumber?: (value: number) => string;
	className?: string;
}

const defaultFormatNumber = (value: number) =>
	value.toLocaleString("ja-JP", { maximumFractionDigits: 6 });

const alignClass = {
	left: "text-left",
	center: "text-center",
	right: "text-right",
} as const;

/** A table of headed columns whose number columns line up on the right. */
export const DataTable = ({
	title,
	columns,
	rows,
	omittedRows = 0,
	formatNumber = defaultFormatNumber,
	className,
}: DataTableProps) => {
	const aligns = columns.map((column, index) => {
		if (column.align) return column.align;
		const numeric =
			rows.length > 0 && rows.every((row) => typeof row[index] === "number");
		return numeric ? "right" : "left";
	});

	return (
		<div
			className={cn(
				"overflow-hidden rounded-lg border border-border bg-card text-foreground",
				className,
			)}
		>
			<div className="overflow-x-auto">
				<table className="w-full border-collapse text-ui">
					{title && (
						<caption className="px-3 py-2 text-left text-ui font-semibold text-foreground">
							{title}
						</caption>
					)}
					<thead>
						<tr>
							{columns.map((column, index) => (
								<th
									key={`${column.header}-${index}`}
									scope="col"
									className={cn(
										"border-b border-border bg-muted/50 px-3 py-2 font-semibold text-muted-foreground",
										alignClass[aligns[index] ?? "left"],
									)}
								>
									{column.header}
								</th>
							))}
						</tr>
					</thead>
					<tbody>
						{rows.map((row, rowIndex) => (
							<tr
								// biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity
								key={rowIndex}
								className="border-b border-border/60 last:border-b-0"
							>
								{columns.map((column, index) => {
									const cell = row[index];
									return (
										<td
											key={`${column.header}-${index}`}
											className={cn(
												"px-3 py-2",
												typeof cell === "number" && "tabular-nums",
												alignClass[aligns[index] ?? "left"],
											)}
										>
											{typeof cell === "number" ? formatNumber(cell) : cell}
										</td>
									);
								})}
							</tr>
						))}
						{rows.length === 0 && (
							<tr>
								<td
									colSpan={columns.length}
									className="px-3 py-6 text-center text-muted-foreground"
								>
									データがありません
								</td>
							</tr>
						)}
					</tbody>
				</table>
			</div>
			{omittedRows > 0 && (
				<p className="border-t border-border px-3 py-2 text-xs text-muted-foreground">
					他{omittedRows}行
				</p>
			)}
		</div>
	);
};
