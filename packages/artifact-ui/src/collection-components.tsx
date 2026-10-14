import {
	Button,
	ConfirmModal,
	Input,
	Modal,
	ServerDataTable,
	Textarea,
	type ServerDataTableProps,
} from "@eumenes/design-system";
import { useEffect, useId, useState } from "react";
import type { ArtifactRequest } from "./contracts";
import type {
	CollectionFormField,
	CollectionRow,
	CollectionRowAction,
} from "./collection-contracts";
import { useAction } from "./components";
import { useArtifactRuntime } from "./runtime";

type Row = CollectionRow;
type Pending = {
	actionId: string;
	rowId: string;
	text: string;
	guard?: string;
};
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
				<span key={action.actionId}>
					<Button
						type="button"
						size="sm"
						variant={action.destructive ? "outline" : "secondary"}
						disabled={disabled || action.disabled}
						aria-label={`${action.label}: ${row.cells[Object.keys(row.cells)[0] ?? ""] ?? row.id}`}
						onClick={() => onAct(row, action)}
					>
						{action.label}
					</Button>
					{action.hint && <small>{action.hint}</small>}
				</span>
			))}
		</span>
	);
}

/**
 * A media value shown on demand: nothing is fetched until the button is pressed, and the object
 * URL made for the preview is revoked when it is replaced or the row goes away.
 */
function MediaCell({ path, mime }: { path: string; mime: string }) {
	const runtime = useArtifactRuntime();
	const [state, setState] = useState<{
		url?: string;
		loading?: boolean;
		error?: string;
	}>({});
	const url = state.url;
	useEffect(
		() => () => {
			if (url) URL.revokeObjectURL(url);
		},
		[url],
	);
	const kind = mime.startsWith("image/")
		? "image"
		: mime.startsWith("audio/")
			? "audio"
			: null;
	if (!kind || !runtime.fetchMedia) return <span>表示できない形式です</span>;
	if (url)
		return kind === "image" ? (
			<img src={url} alt="" style={{ maxWidth: "12rem" }} />
		) : (
			// oxlint-disable-next-line jsx-a11y/media-has-caption -- a stored recording has no captions
			<audio controls src={url} />
		);
	return (
		<span>
			<Button
				type="button"
				size="sm"
				variant="secondary"
				disabled={state.loading}
				onClick={() => {
					setState({ loading: true });
					runtime.fetchMedia!(path)
						.then((blob) => setState({ url: URL.createObjectURL(blob) }))
						.catch(() => setState({ error: "読み込めませんでした。" }));
				}}
			>
				{kind === "image" ? "画像を表示" : "音声を再生"}
			</Button>
			{state.error && <small role="alert">{state.error}</small>}
		</span>
	);
}

function MediaValue({ row, column }: { row: Row; column: string }) {
	const media = row.media?.[column];
	return media ? (
		<MediaCell key={media.path} path={media.path} mime={media.mime} />
	) : (
		<span>{row.cells[column]}</span>
	);
}

function CollectionForm({
	label,
	fields,
	initial: start,
	busy,
	notice,
	onSubmit,
}: {
	label: string;
	/** Why the last send did not go through (the dialog stays open). */
	notice?: string;
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
						{/* The visible state matches the value: nothing is chosen yet. */}
						{!field.options?.some((o) => o.value === "") &&
							String(value) === "" && (
								<option value="">選択してください</option>
							)}
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
			{notice && <p role="alert">{notice}</p>}
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
	const failed = action.status === "conflict" || action.status === "rejected";
	const notice = failed ? action.message : "";
	const act = (row: Row, chosen: CollectionRowAction) => {
		// The dialog keeps the row as it was when it opened; the host compares its guard.
		if (chosen.form) setEditing({ row, action: chosen });
		else if (chosen.confirm)
			setPending({
				actionId: chosen.actionId,
				rowId: row.id,
				text: chosen.confirm,
				guard: chosen.guard,
			});
		else
			void action.send("collection-action", {
				actionId: chosen.actionId,
				rowId: row.id,
				...(chosen.guard ? { guard: chosen.guard } : {}),
			});
	};
	const columns: ServerDataTableProps<Row>["columns"] = [
		...data.columns.map((column) => ({
			id: column.key,
			header: column.label,
			accessorFn: (row: Row) => row.cells[column.key] ?? "",
			...(column.media
				? {
						enableSorting: false,
						cell: ({ row }: { row: { original: Row } }) => (
							<MediaValue row={row.original} column={column.key} />
						),
					}
				: {}),
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
			{data.description && <p>{data.description}</p>}
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
									<td key={column.key}>
										{column.media ? (
											<MediaValue row={row} column={column.key} />
										) : (
											row.cells[column.key]
										)}
									</td>
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
						notice={notice}
						onSubmit={async (values) => {
							const ok = await action.send("collection-action", {
								actionId: editing.action.actionId,
								rowId: editing.row.id,
								...(editing.action.guard
									? { guard: editing.action.guard }
									: {}),
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
				description={
					pending ? `${pending.text}${notice ? `\n${notice}` : ""}` : undefined
				}
				confirmText="実行する"
				cancelText="やめる"
				variant="destructive"
				onConfirm={() => {
					// The dialog stays open when the row changed meanwhile: it says so.
					if (pending)
						void action
							.send("collection-action", {
								actionId: pending.actionId,
								rowId: pending.rowId,
								...(pending.guard ? { guard: pending.guard } : {}),
							})
							.then((ok) => {
								if (ok) setPending(null);
							});
				}}
			/>
		</section>
	);
}
