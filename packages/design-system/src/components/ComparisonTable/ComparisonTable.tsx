import { Check, Minus } from "lucide-react";
import { cn } from "../../utils/cn";
import "./ComparisonTable.css";

export type ComparisonTableRow = {
	label: string;
	/** 文字列はそのまま、真偽値は「あり」「なし」のアイコンで表示する。 */
	values: Array<string | boolean>;
};

export type ComparisonTableProps = {
	title?: string;
	/** 値列の見出し。先頭の項目名の列は含めない。 */
	columns: string[];
	rows: ComparisonTableRow[];
	/** 強調する値列の位置（columns の添字）。 */
	highlightColumn?: number;
	className?: string;
};

export function ComparisonTable({
	title,
	columns,
	rows,
	highlightColumn,
	className,
}: ComparisonTableProps) {
	return (
		<section className={cn("ds-comparison-table", className)}>
			{title && <h3 className="ds-comparison-table-title">{title}</h3>}
			<div
				className="ds-comparison-table-scroll"
				role="region"
				aria-label={title ?? "比較表"}
				// oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- 横スクロールをキーボードから操作できるようにフォーカスを受ける
				tabIndex={0}
			>
				<table>
					<thead>
						<tr>
							<th scope="col" className="ds-comparison-table-corner">
								<span className="ds-comparison-table-sr">項目</span>
							</th>
							{columns.map((column, index) => (
								<th
									key={`${index}-${column}`}
									scope="col"
									data-highlight={index === highlightColumn}
								>
									{column}
								</th>
							))}
						</tr>
					</thead>
					<tbody>
						{rows.map((row, rowIndex) => (
							<tr key={`${rowIndex}-${row.label}`}>
								<th scope="row">{row.label}</th>
								{columns.map((column, index) => (
									<td
										key={`${index}-${column}`}
										data-highlight={index === highlightColumn}
									>
										<Cell value={row.values[index]} />
									</td>
								))}
							</tr>
						))}
					</tbody>
				</table>
			</div>
		</section>
	);
}

function Cell({ value }: { value: string | boolean | undefined }) {
	if (value === true)
		return (
			<span className="ds-comparison-table-mark" data-state="yes">
				<Check aria-hidden="true" />
				<span className="ds-comparison-table-sr">あり</span>
			</span>
		);
	if (value === false)
		return (
			<span className="ds-comparison-table-mark" data-state="no">
				<Minus aria-hidden="true" />
				<span className="ds-comparison-table-sr">なし</span>
			</span>
		);
	return <>{value ?? ""}</>;
}
