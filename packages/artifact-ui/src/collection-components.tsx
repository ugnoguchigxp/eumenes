import {
	Button,
	ConfirmModal,
	Input,
	Modal,
	ServerDataTable,
	Textarea,
	type ServerDataTableProps,
} from "@eumenes/design-system";
import { useId, useState } from "react";
import type { ArtifactRequest } from "./contracts";
import type {
	CollectionFormField,
	CollectionRow,
	CollectionRowAction,
} from "./collection-contracts";
import { useAction } from "./components";

type Row = CollectionRow;
type Pending = { actionId: string; rowId: string; text: string };
type Editing = { row: Row; action: CollectionRowAction };

function RowActions({
	row,
	disabled,
	onAct,
}: {
	row: Row;
	disabled: boolean;
	onAct: (row: Row, action: CollectionRowAction) => void;
}) {
	return (
		<span className="aui-row-actions">
			{row.actions.map((action) => (
				<Button
					key={action.actionId}
					type="button"
					size="sm"
					variant={action.destructive ? "outline" : "secondary"}
					disabled={disabled || action.disabled}
					aria-label={`${action.label}: ${row.cells[Object.keys(row.cells)[0] ?? ""] ?? row.id}`}
					onClick={() => onAct(row, action)}
				>
					{action.label}
				</Button>
			))}
		</span>
	);
}

function CollectionForm({
	label,
	fields,
	initial: start,
	busy,
	onSubmit,
}: {
	label: string;
	fields: CollectionFormField[];
	initial?: Record<string, string | boolean>;
	busy: boolean;
	onSubmit: (values: Record<string, string | boolean>) => Promise<boolean>;
}) {
	const prefix = useId();
	const initial = () =>
		Object.fromEntries(
			fields.map((f) => [
				f.id,
				start?.[f.id] ??
					(f.control === "toggle"
						? f.defaultValue === "true"
						: (f.defaultValue ?? "")),
			]),
		) as Record<string, string | boolean>;
	const [values, setValues] = useState(initial);
	const set = (id: string, value: string | boolean) =>
		setValues((old) => ({ ...old, [id]: value }));
	const input = (field: CollectionFormField) => {
		const id = `${prefix}-${field.id}`;
		const value = values[field.id];
		switch (field.control) {
			case "textarea":
				return (
					<Textarea
						id={id}
						value={String(value)}
						maxLength={field.maxLength}
						onChange={(e) => set(field.id, e.target.value)}
					/>
				);
			case "select":
				return (
					<select
						id={id}
						value={String(value)}
						onChange={(e) => set(field.id, e.target.value)}
					>
						{field.options?.map((o) => (
							<option key={o.value} value={o.value}>
								{o.label}
							</option>
						))}
					</select>
				);
			case "toggle":
				return (
					<input
						id={id}
						type="checkbox"
						checked={value === true}
						onChange={(e) => set(field.id, e.target.checked)}
					/>
				);
			default:
				return (
					<Input
						id={id}
						type={
							field.control === "secret"
								? "password"
								: field.control === "number"
									? "number"
									: "text"
						}
						autoComplete="off"
						value={String(value)}
						maxLength={field.maxLength}
						onChange={(e) => set(field.id, e.target.value)}
					/>
				);
		}
	};
	return (
		<form
			className="aui-stack"
			aria-label={label}
			onSubmit={(event) => {
				event.preventDefault();
				void onSubmit(values).then((ok) => {
					// Secrets never stay in the form after a send.
					if (ok) setValues(initial());
				});
			}}
		>
			{fields.map((field) => (
				<label key={field.id} htmlFor={`${prefix}-${field.id}`}>
					{field.label}
					{field.required && "（必須）"}
					{input(field)}
					{field.help && <small>{field.help}</small>}
				</label>
			))}
			<Button type="submit" disabled={busy}>
				{label}
			</Button>
		</form>
	);
}

/** A registered list editor: table, row actions with confirmation, and a create form. */
export function CollectionWorkspaceView({
	request,
}: {
	request: ArtifactRequest;
}) {
	const action = useAction(request);
	const data = action.resource;
	const [pending, setPending] = useState<Pending | null>(null);
	const [editing, setEditing] = useState<Editing | null>(null);
	if (data?.kind !== "collection") return null;
	const busy = !!data.busy || action.pending;
	const act = (row: Row, chosen: CollectionRowAction) => {
		if (chosen.form) setEditing({ row, action: chosen });
		else if (chosen.confirm)
			setPending({
				actionId: chosen.actionId,
				rowId: row.id,
				text: chosen.confirm,
			});
		else
			void action.send("collection-action", {
				actionId: chosen.actionId,
				rowId: row.id,
			});
	};
	const columns: ServerDataTableProps<Row>["columns"] = [
		...data.columns.map((column) => ({
			id: column.key,
			header: column.label,
			accessorFn: (row: Row) => row.cells[column.key] ?? "",
		})),
		...(data.rows.some((row) => row.actions.length)
			? [
					{
						id: "actions",
						header: "操作",
						enableSorting: false,
						cell: ({ row }: { row: { original: Row } }) => (
							<RowActions row={row.original} disabled={busy} onAct={act} />
						),
					},
				]
			: []),
	];
	return (
		<section className="aui-stack" aria-label={data.title ?? request.title}>
			{request.title && <h3>{request.title}</h3>}
			{data.paging ? (
				<ServerDataTable
					label={data.title ?? request.title ?? "一覧"}
					rows={data.rows}
					columns={columns}
					query={data.paging}
					total={data.total}
					busy={busy}
					error={data.error}
					emptyMessage={data.emptyMessage}
					onQuery={(query) =>
						void action.send("collection-page", {
							pageIndex: String(query.pageIndex),
							pageSize: String(query.pageSize),
							sort: query.sort,
							desc: query.desc,
							q: query.q,
						})
					}
				/>
			) : (
				<table aria-label={data.title ?? request.title ?? "一覧"}>
					<thead>
						<tr>
							{data.columns.map((column) => (
								<th key={column.key} scope="col">
									{column.label}
								</th>
							))}
							{data.rows.some((row) => row.actions.length) && (
								<th scope="col">操作</th>
							)}
						</tr>
					</thead>
					<tbody>
						{data.rows.map((row) => (
							<tr key={row.id}>
								{data.columns.map((column) => (
									<td key={column.key}>{row.cells[column.key]}</td>
								))}
								{row.actions.length > 0 && (
									<td>
										<RowActions row={row} disabled={busy} onAct={act} />
									</td>
								)}
							</tr>
						))}
					</tbody>
				</table>
			)}
			{!data.paging && data.rows.length === 0 && (
				<p>{data.emptyMessage ?? "項目はありません。"}</p>
			)}
			{data.error && !data.paging && <p role="alert">{data.error}</p>}
			{data.create && (
				<CollectionForm
					label={data.create.label}
					fields={data.create.fields}
					busy={busy}
					onSubmit={async (values) => {
						const ok = await action.send("collection-create", {
							actionId: data.create!.actionId,
							...values,
						});
						return ok;
					}}
				/>
			)}
			<output aria-live="polite">{action.message || data.message}</output>
			<Modal
				open={!!editing}
				onOpenChange={(open) => {
					if (!open) setEditing(null);
				}}
				title={editing?.action.label}
			>
				{editing?.action.form && (
					<CollectionForm
						key={`${editing.row.id}:${editing.action.actionId}`}
						label={editing.action.label}
						fields={editing.action.form.fields}
						initial={editing.action.form.values}
						busy={busy}
						onSubmit={async (values) => {
							const ok = await action.send("collection-action", {
								actionId: editing.action.actionId,
								rowId: editing.row.id,
								...values,
							});
							if (ok) setEditing(null);
							return ok;
						}}
					/>
				)}
			</Modal>
			<ConfirmModal
				open={!!pending}
				onOpenChange={(open) => {
					if (!open) setPending(null);
				}}
				title="確認"
				description={pending?.text}
				confirmText="実行する"
				cancelText="やめる"
				variant="destructive"
				onConfirm={() => {
					if (pending)
						void action.send("collection-action", {
							actionId: pending.actionId,
							rowId: pending.rowId,
						});
					setPending(null);
				}}
			/>
		</section>
	);
}
