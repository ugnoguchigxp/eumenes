/**
 * Views of the UI studio that show numbers: chart, data-table, formula and calculator. They read
 * the composition's shared state (`useCompositionModel`) and work without one, with static data.
 */
import {
	Calculator,
	Chart,
	DataTable,
	type DataTableColumn,
	Formula,
} from "@eumenes/design-system";
import { useMemo } from "react";
import type {
	CompositionModel,
	CompositionPoint,
	CompositionValue,
} from "./composition-contracts";
import { evaluateExpression, parseExpression } from "./composition-expressions";
import {
	type CompositionFormat,
	formatCompositionValue,
} from "./composition-format";
import { useCompositionModel } from "./composition-model";
import type { ArtifactRequest } from "./contracts";

/** Rows a data-table shows; the rest is reported as omitted. */
const maxTableRows = 200;

const noScope = { get: () => undefined };

/** Evaluates with the composition's state, or with no names at all when it has none. */
function evaluateWith(
	model: CompositionModel | null,
	source: string,
	locals?: Readonly<Record<string, CompositionValue>>,
): CompositionValue {
	if (model) return model.evaluate(source, locals);
	const parsed = parseExpression(source);
	if (!parsed.ok) return null;
	return evaluateExpression(
		parsed.ast,
		locals ? new Map(Object.entries(locals)) : noScope,
	);
}

/** The points of a model value that is a series; nothing for any other value. */
function pointsOf(value: CompositionValue | undefined): CompositionPoint[] {
	if (!Array.isArray(value)) return [];
	return (value as readonly CompositionPoint[]).filter(
		(point) =>
			point !== null &&
			typeof point === "object" &&
			typeof point.y === "number" &&
			Number.isFinite(point.y) &&
			(typeof point.x === "number" || typeof point.x === "string"),
	);
}

const formatOf = ({ format, decimals, unit }: CompositionFormat) => ({
	format,
	decimals,
	unit,
});

export function ChartView({ request }: { request: ArtifactRequest }) {
	const model = useCompositionModel();
	if (request.view !== "chart") return null;
	const series = request.series.map((s) => ({
		name: s.name,
		points: s.from ? pointsOf(model?.value(s.from)) : (s.points ?? []),
	}));
	const display = formatOf(request);
	return (
		<Chart
			kind={request.kind}
			series={series}
			formatValue={(value) => formatCompositionValue(value, display)}
			{...(request.title && { title: request.title })}
			{...(request.xLabel && { xLabel: request.xLabel })}
			{...(request.yLabel && { yLabel: request.yLabel })}
			{...(request.note && { note: request.note })}
		/>
	);
}

export function DataTableView({ request }: { request: ArtifactRequest }) {
	const model = useCompositionModel();
	const table = useMemo(() => {
		if (request.view !== "data-table") return null;
		const columns = request.columns;
		let values: CompositionValue[][];
		let omittedRows = 0;
		if (request.series) {
			const points = pointsOf(model?.value(request.series));
			omittedRows = Math.max(0, points.length - maxTableRows);
			values = points
				.slice(0, maxTableRows)
				.map((point) =>
					columns.map((column) =>
						column.expr
							? evaluateWith(model, column.expr, { x: point.x, y: point.y })
							: null,
					),
				);
		} else {
			const rows = request.rows ?? [];
			omittedRows = Math.max(0, rows.length - maxTableRows);
			values = rows.slice(0, maxTableRows);
		}
		const tableColumns: DataTableColumn[] = columns.map((column, index) => ({
			header: column.header,
			align:
				values.length > 0 &&
				values.every((row) => typeof row[index] === "number")
					? "right"
					: "left",
		}));
		const rows = values.map((row) =>
			columns.map((column, index) => {
				const cell = row[index] ?? null;
				return typeof cell === "string"
					? cell
					: formatCompositionValue(cell, formatOf(column));
			}),
		);
		return { columns: tableColumns, rows, omittedRows };
	}, [request, model]);
	if (request.view !== "data-table" || !table) return null;
	return (
		<DataTable
			columns={table.columns}
			rows={table.rows}
			omittedRows={table.omittedRows}
			{...(request.title && { title: request.title })}
		/>
	);
}

export function FormulaView({ request }: { request: ArtifactRequest }) {
	const model = useCompositionModel();
	if (request.view !== "formula") return null;
	const value = request.expr
		? `= ${formatCompositionValue(evaluateWith(model, request.expr), formatOf(request))}`
		: undefined;
	return (
		<Formula
			tex={request.tex}
			{...(request.label && { label: request.label })}
			{...(value && { value })}
			{...(request.caption && { caption: request.caption })}
		/>
	);
}

export function CalculatorView({ request }: { request: ArtifactRequest }) {
	const model = useCompositionModel();
	if (request.view !== "calculator") return null;
	const { resultBind } = request;
	return (
		<div className="aui-calculator">
			{request.label && (
				<p style={{ margin: "0 0 0.5rem", fontWeight: 600 }}>{request.label}</p>
			)}
			<Calculator
				display="inline"
				mode={request.mode ?? "basic"}
				evaluate={(expression) => {
					const result = evaluateWith(model, expression);
					return typeof result === "number" ? result : null;
				}}
				{...(request.preset && { initialExpression: request.preset })}
				onResult={(result) => {
					if (resultBind) model?.set(resultBind, result);
				}}
			/>
		</div>
	);
}
