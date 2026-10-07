import type { ReactNode } from "react";

interface MiniTableColumn {
	key: string;
	label: string;
	align?: "left" | "center" | "right";
	width?: string;
}

interface MiniTableRow {
	key: string;
	cells: Record<string, ReactNode>;
}

interface MiniTableProps {
	columns: MiniTableColumn[];
	rows: MiniTableRow[];
	dense?: boolean;
	size?: "sm" | "md" | "lg";
	headerBg?: string;
	hideHeader?: boolean;
}

/**
 * Compact, borderless table for small item comparisons (e.g., wound care materials or therapy items).
 */
export const MiniTable: React.FC<MiniTableProps> = ({
	columns,
	rows,
	dense: _dense = false,
	size: _size = "sm",
	headerBg,
	hideHeader = false,
}) => {
	const basePadding =
		"px-[var(--ui-component-padding-x)] py-[var(--ui-component-padding-y)]";
	const headerTextClass = "text-ui";
	const bodyTextClass = "text-ui";
	const bodyPadding = basePadding;

	return (
		<div className="overflow-hidden rounded border border-border bg-card m-0">
			<div
				className="grid"
				style={{
					gridTemplateColumns: columns.map((c) => c.width || "1fr").join(" "),
				}}
			>
				{!hideHeader &&
					columns.map((col) => (
						<div
							key={col.key}
							className={`${headerTextClass} font-semibold uppercase tracking-wide text-muted-foreground border-b border-border ${headerBg || ""} ${basePadding}`}
							style={{ textAlign: col.align || "left" }}
						>
							{col.label}
						</div>
					))}
				{rows.map((row) =>
					columns.map((col) => (
						<div
							key={`${row.key}-${col.key}`}
							className={`${bodyTextClass} text-foreground border-b border-border/60 last:border-b-0 ${bodyPadding}`}
							style={{ textAlign: col.align || "left" }}
						>
							{row.cells[col.key]}
						</div>
					)),
				)}
			</div>
		</div>
	);
};
