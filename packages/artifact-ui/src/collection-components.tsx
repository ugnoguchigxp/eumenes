import {
	Button,
	ConfirmModal,
	Input,
	Modal,
	ServerDataTable,
	Textarea,
	type ServerDataTableProps,
} from "@eumenes/design-system";
import { useEffect, useId, useRef, useState } from "react";
import type { ArtifactRequest } from "./contracts";
import type {
	CollectionFormField,
	CollectionRow,
	CollectionRowAction,
	CollectionResource,
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

function CollectionSummary({
	data,
	busy,
	onAct,
}: {
	data: CollectionResource;
	busy: boolean;
	onAct: (row: Row, action: CollectionRowAction) => void;
}) {
	return (
		<div className="aui-collection-summary">
			{data.rows.length === 0 && (
				<p>{data.emptyMessage ?? "項目はありません。"}</p>
			)}
			{data.rows.map((row) => (
				<div key={row.id}>
					<dl>
						{data.columns.map((column) => (
							<div key={column.key}>
								<dt>{column.label}</dt>
								<dd>{row.cells[column.key]}</dd>
							</div>
						))}
					</dl>
					{row.actions.length > 0 && (
						<RowActions row={row} disabled={busy} onAct={onAct} />
					)}
				</div>
			))}
		</div>
	);
}

function tableColumns(
	data: CollectionResource,
	busy: boolean,
	onAct: (row: Row, action: CollectionRowAction) => void,
): ServerDataTableProps<Row>["columns"] {
	return [
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
							<RowActions row={row.original} disabled={busy} onAct={onAct} />
						),
					},
				]
			: []),
	];
}

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
	source,
	label,
	fields,
	initial: start,
	busy,
	notice,
	onSubmit,
}: {
	source: string;
	label: string;
	/** Why the last send did not go through (the dialog stays open). */
	notice?: string;
	fields: CollectionFormField[];
	initial?: Record<string, string | boolean>;
	busy: boolean;
	onSubmit: (values: Record<string, string | boolean>) => Promise<boolean>;
}) {
	const runtime = useArtifactRuntime();
	const prefix = useId();
	const uploadGeneration = useRef(0);
	const [uploading, setUploading] = useState(false);
	const [uploadError, setUploadError] = useState("");
	const [uploadName, setUploadName] = useState("");
	useEffect(
		() => () => {
			uploadGeneration.current++;
		},
		[],
	);
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
			case "upload":
				return (
					<>
						<input
							id={id}
							type="file"
							accept={field.accept}
							disabled={busy || uploading}
							onChange={async (event) => {
								const file = event.target.files?.[0];
								if (!file) return;
								const generation = ++uploadGeneration.current;
								set(field.id, "");
								setUploadName("");
								setUploadError("");
								setUploading(true);
								try {
									const result = await runtime.uploadFile?.(source, file);
									if (generation !== uploadGeneration.current) return;
									if (result?.status === "accepted" && result.value) {
										set(field.id, result.value);
										setUploadName(file.name);
									} else
										setUploadError(
											result?.message || "ファイルを読み込めませんでした。",
										);
								} catch {
									if (generation === uploadGeneration.current)
										setUploadError("ファイルを読み込めませんでした。");
								} finally {
									if (generation === uploadGeneration.current)
										setUploading(false);
								}
							}}
						/>
						{uploadName && <small>{uploadName}</small>}
					</>
				);
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
			{fields
				.filter(
					(field) =>
						!field.when ||
						field.when.in.includes(values[field.when.key] as never),
				)
				.map((field) => (
					<label key={field.id} htmlFor={`${prefix}-${field.id}`}>
						{field.label}
						{field.required && "（必須）"}
						{input(field)}
						{field.help && <small>{field.help}</small>}
					</label>
				))}
			{notice && <p role="alert">{notice}</p>}
			{uploadError && <p role="alert">{uploadError}</p>}
			<Button type="submit" disabled={busy || uploading}>
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
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [search, setSearch] = useState("");
	if (data?.kind !== "collection") return null;
	const catalog =
		request.view === "collection-workspace" &&
		request.presentation === "catalog" &&
		!data.paging;
	const summary =
		request.view === "collection-workspace" &&
		request.presentation === "summary" &&
		!data.paging;
	const foundRows = data.rows.filter((row) =>
		Object.values(row.cells).some((value) =>
			value.toLocaleLowerCase().includes(search.toLocaleLowerCase()),
		),
	);
	const selectedRow =
		foundRows.find((row) => row.id === selectedId) ?? foundRows[0];
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
	const columns = tableColumns(data, busy, act);
	return (
		<section
			className="aui-stack aui-collection-workspace"
			aria-label={data.title ?? request.title}
		>
			{request.title && <h3>{request.title}</h3>}
			{data.description && <p>{data.description}</p>}
			{summary ? (
				<CollectionSummary data={data} busy={busy} onAct={act} />
			) : catalog ? (
				<div className="aui-collection-catalog">
					<aside aria-label={`${data.title ?? request.title ?? "項目"}の一覧`}>
						<Input
							type="search"
							aria-label="一覧を検索"
							placeholder="一覧を検索"
							value={search}
							onChange={(event) => setSearch(event.target.value)}
						/>
						<div className="aui-collection-catalog-list">
							{foundRows.map((row) => (
								<button
									key={row.id}
									type="button"
									aria-pressed={selectedRow?.id === row.id}
									onClick={() => setSelectedId(row.id)}
								>
									<strong>
										{row.cells[data.columns[0]?.key ?? ""] ?? row.id}
									</strong>
									<small>
										{data.columns
											.slice(1, 3)
											.map((column) => row.cells[column.key])
											.filter(Boolean)
											.join(" · ")}
									</small>
								</button>
							))}
							{foundRows.length === 0 && (
								<p>{data.emptyMessage ?? "項目はありません。"}</p>
							)}
						</div>
					</aside>
					<div className="aui-collection-catalog-detail">
						{selectedRow ? (
							<>
								<h4>
									{selectedRow.cells[data.columns[0]?.key ?? ""] ??
										selectedRow.id}
								</h4>
								<dl>
									{data.columns.slice(1).map((column) => (
										<div key={column.key}>
											<dt>{column.label}</dt>
											<dd>
												{column.media ? (
													<MediaValue row={selectedRow} column={column.key} />
												) : (
													selectedRow.cells[column.key]
												)}
											</dd>
										</div>
									))}
								</dl>
								{selectedRow.actions.length > 0 && (
									<RowActions row={selectedRow} disabled={busy} onAct={act} />
								)}
							</>
						) : (
							<p>
								{data.rows.length
									? "一覧から項目を選択すると詳細が表示されます。"
									: "まだ登録された項目はありません。"}
							</p>
						)}
						{data.create && (
							<details className="aui-collection-create">
								<summary>{data.create.label}</summary>
								<CollectionForm
									source={action.source}
									key={selectedRow?.id ?? "empty"}
									label={data.create.label}
									fields={data.create.fields}
									initial={
										request.view === "collection-workspace" &&
										request.selectionField &&
										selectedRow
											? { [request.selectionField]: selectedRow.id }
											: undefined
									}
									busy={busy}
									onSubmit={async (values) =>
										action.send("collection-create", {
											actionId: data.create!.actionId,
											...values,
										})
									}
								/>
							</details>
						)}
					</div>
				</div>
			) : data.paging ? (
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
			{!data.paging && !catalog && !summary && data.rows.length === 0 && (
				<p>{data.emptyMessage ?? "項目はありません。"}</p>
			)}
			{data.error && !data.paging && <p role="alert">{data.error}</p>}
			{data.create && !catalog && (
				<CollectionForm
					source={action.source}
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
			{/* A dialog shows its own refusal; it is not repeated outside. */}
			<output aria-live="polite">
				{(editing || pending) && failed ? "" : action.message || data.message}
			</output>
			<Modal
				open={!!editing}
				onOpenChange={(open) => {
					if (!open) setEditing(null);
				}}
				title={editing?.action.label}
			>
				{editing?.action.form && (
					<CollectionForm
						source={action.source}
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
