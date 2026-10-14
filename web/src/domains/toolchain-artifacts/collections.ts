import type {
	ArtifactEvent,
	CollectionFormField,
	CollectionResource,
	CollectionRow,
} from "@eumenes/artifact-ui";
import type {
	ActionBindingV1,
	CollectionV1,
	FormFieldV1,
} from "../../../../api/domains/capabilities/contracts";

/** A fixed dot path into a plain object (`a.b.c`); undefined when any step is missing. */
export function getPath(value: unknown, path: string): unknown {
	let node: unknown = value;
	for (const key of path.split(".")) {
		if (!node || typeof node !== "object" || Array.isArray(node))
			return undefined;
		node = (node as Record<string, unknown>)[key];
	}
	return node;
}

export type PagingQuery = {
	pageIndex: number;
	pageSize: number;
	sort: string;
	desc: boolean;
	q: string;
};
export const defaultPaging: PagingQuery = {
	pageIndex: 0,
	pageSize: 10,
	sort: "",
	desc: false,
	q: "",
};

/** The `params` of a paged source read: the table query, without an empty sort. */
export function pagingParams(query: PagingQuery) {
	return {
		pageIndex: query.pageIndex,
		pageSize: query.pageSize,
		desc: query.desc,
		q: query.q,
		...(query.sort ? { sort: query.sort } : {}),
	};
}

/** The rows of a source answer: the data itself, or the array at `rowsPath`. */
export function rowsOf(collection: CollectionV1, data: unknown): unknown[] {
	const rows = collection.rowsPath ? getPath(data, collection.rowsPath) : data;
	return Array.isArray(rows) ? rows : [];
}

export function totalOf(
	collection: CollectionV1,
	data: unknown,
	rowCount: number,
): number {
	const total =
		collection.paging && data && typeof data === "object"
			? (data as { total?: unknown }).total
			: undefined;
	return typeof total === "number" ? total : rowCount;
}

function format(value: unknown, as: CollectionV1["columns"][number]["format"]) {
	if (value === undefined || value === null || value === "") return "—";
	switch (as) {
		case "media":
			return "—";
		case "boolean":
			return value === true
				? "はい"
				: value === false
					? "いいえ"
					: String(value);
		case "date": {
			const date =
				typeof value === "number" ? new Date(value) : new Date(String(value));
			return Number.isNaN(date.getTime())
				? String(value)
				: date.toLocaleString("ja-JP");
		}
		default:
			return String(value);
	}
}

const rowKeyOf = (collection: CollectionV1, row: unknown) => {
	const key = getPath(row, collection.rowKey);
	return typeof key === "string" || typeof key === "number"
		? String(key)
		: undefined;
};

/** The raw row with this id, as the host holds it (never taken from the event). */
export function findRow(collection: CollectionV1, data: unknown, id: string) {
	return rowsOf(collection, data).find(
		(row) => rowKeyOf(collection, row) === id,
	);
}

/** The choices a form field offers: a source's `options` when it has an `optionsSource`. */
export type FormOptions = ReadonlyMap<
	string,
	ReadonlyArray<{ value: string; label: string }>
>;
export function withOptions(
	fields: readonly FormFieldV1[],
	fetched: FormOptions,
): FormFieldV1[] {
	return fields.map((f) => {
		const options = f.optionsSource ? fetched.get(f.optionsSource) : undefined;
		return options ? { ...f, options: [...options] } : f;
	});
}

function formFieldView(field: FormFieldV1): CollectionFormField {
	return {
		id: field.fieldId,
		label: field.label,
		...(field.help ? { help: field.help } : {}),
		control: field.control,
		...(field.when ? { when: field.when } : {}),
		...(field.accept ? { accept: field.accept } : {}),
		...(field.defaultValue !== undefined
			? { defaultValue: field.defaultValue }
			: {}),
		...(field.options ? { options: field.options } : {}),
		...(field.maxLength ? { maxLength: field.maxLength } : {}),
		...(field.min !== undefined ? { min: field.min } : {}),
		...(field.max !== undefined ? { max: field.max } : {}),
		...(field.required ? { required: true } : {}),
	};
}

/** The `{path, mime}` values of media columns; anything else is left out. */
function mediaOf(collection: CollectionV1, raw: unknown) {
	const media: Record<string, { path: string; mime: string }> = {};
	for (const column of collection.columns) {
		if (column.format !== "media") continue;
		const value = getPath(raw, column.key) as {
			path?: unknown;
			mime?: unknown;
		};
		if (
			value &&
			typeof value.path === "string" &&
			typeof value.mime === "string"
		)
			media[column.key] = { path: value.path, mime: value.mime };
	}
	return Object.keys(media).length ? { media } : {};
}

function prefillOf(
	form: NonNullable<CollectionV1["rowActions"][number]["form"]>,
	row: unknown,
): Record<string, string | boolean> {
	const values: Record<string, string | boolean> = {};
	for (const [fieldId, path] of Object.entries(form.prefill)) {
		const value = getPath(row, path.slice("$row.".length));
		if (typeof value === "boolean") values[fieldId] = value;
		else if (value !== undefined && value !== null)
			values[fieldId] = String(value);
	}
	return values;
}

/** 32-bit FNV-1a, as hex: a cheap digest to compare row values, not a security measure. */
function digest(text: string) {
	let hash = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(16);
}

/**
 * A digest of the row values a row action depends on: the fields its input is built from, its
 * form starts from, and its `when` watches. The view hands back the one it held when a dialog
 * opened, so an action never runs on a row that changed meanwhile.
 */
export function guardOf(
	rowAction: CollectionV1["rowActions"][number],
	binding: ActionBindingV1 | undefined,
	row: unknown,
): string {
	const paths = new Set<string>();
	for (const source of Object.values(binding?.rowInput ?? {}))
		if (typeof source === "string") paths.add(source.slice("$row.".length));
	for (const path of Object.values(rowAction.form?.prefill ?? {}))
		paths.add(path.slice("$row.".length));
	if (rowAction.when) paths.add(rowAction.when.key);
	return digest(JSON.stringify([...paths].sort().map((p) => getPath(row, p))));
}

/**
 * The resource of a registered collection from its source data. Row actions come from the
 * registration (with the action binding's `label`), filtered by their finite `when`.
 */
export function collectionResource({
	collection,
	data,
	bindings,
	revision,
	query,
	busy,
	error,
	message,
	title,
	formOptions = new Map(),
	dirtyDocuments = new Set(),
}: {
	/** Documents whose shared draft has unapplied changes (see `requiresCleanDraft`). */
	dirtyDocuments?: ReadonlySet<string>;
	formOptions?: FormOptions;
	collection: CollectionV1;
	data: unknown;
	bindings: ReadonlyArray<ActionBindingV1>;
	revision: number;
	query: PagingQuery;
	busy: boolean;
	error?: string;
	message?: string;
	title?: string;
}): CollectionResource {
	const labelOf = (actionId: string) =>
		bindings.find((b) => b.actionId === actionId)?.label ?? actionId;
	const rows: CollectionRow[] = rowsOf(collection, data).flatMap((raw) => {
		const id = rowKeyOf(collection, raw);
		if (id === undefined) return [];
		return [
			{
				id,
				cells: Object.fromEntries(
					collection.columns.map((c) => [
						c.key,
						format(getPath(raw, c.key), c.format),
					]),
				),
				...mediaOf(collection, raw),
				actions: collection.rowActions
					.filter(
						(a) =>
							!a.when || a.when.in.includes(getPath(raw, a.when.key) as never),
					)
					.map((a) => ({
						actionId: a.actionId,
						label: labelOf(a.actionId),
						guard: guardOf(
							a,
							bindings.find((b) => b.actionId === a.actionId),
							raw,
						),
						...(a.requiresCleanDraft && dirtyDocuments.has(a.requiresCleanDraft)
							? {
									disabled: true,
									hint: "未適用の変更を適用してから確認してください",
								}
							: {}),
						...(a.confirm ? { confirm: a.confirm, destructive: true } : {}),
						...(a.form
							? {
									form: {
										fields: withOptions(
											a.form.fields.filter(
												(field) =>
													!field.when ||
													field.when.in.includes(
														getPath(raw, field.when.key) as never,
													),
											),
											formOptions,
										).map(formFieldView),
										values: prefillOf(a.form, raw),
									},
								}
							: {}),
					})),
			},
		];
	});
	return {
		kind: "collection",
		revision,
		...(title || collection.title ? { title: title ?? collection.title } : {}),
		...(collection.description ? { description: collection.description } : {}),
		columns: collection.columns.map((c) => ({
			key: c.key,
			label: c.label,
			...(c.format === "media" ? { media: true as const } : {}),
		})),
		rows,
		total: totalOf(collection, data, rows.length),
		...(collection.paging ? { paging: query } : {}),
		...(collection.create
			? {
					create: {
						actionId: collection.create.actionId,
						label: labelOf(collection.create.actionId),
						fields: withOptions(collection.create.fields, formOptions).map(
							formFieldView,
						),
					},
				}
			: {}),
		busy,
		...(error ? { error } : {}),
		...(message ? { message } : {}),
	};
}

/**
 * The operation input of a row action: each key is a fixed `$row.path` of the row the host
 * holds or a registered literal. Nothing of the event beyond the row id is used.
 */
export function rowInput(
	binding: ActionBindingV1,
	row: unknown,
	newId: () => string = () => crypto.randomUUID(),
): Record<string, unknown> {
	const input: Record<string, unknown> = {};
	for (const [key, source] of Object.entries(binding.rowInput ?? {})) {
		if (typeof source === "string")
			input[key] = getPath(row, source.slice("$row.".length));
		else if ("generate" in source) input[key] = newId();
		else input[key] = source.literal;
	}
	return input;
}

/** The id the host made for the element an action creates: its first generated (`{generate:"uuid"}`) input key. */
export function createdId(
	binding: ActionBindingV1,
	input: Record<string, unknown>,
): string | undefined {
	const key = Object.entries(binding.rowInput ?? {}).find(
		([, source]) => typeof source !== "string" && "generate" in source,
	)?.[0];
	const value = key ? input[key] : undefined;
	return typeof value === "string" ? value : undefined;
}

export type FormValues = Readonly<Record<string, string | boolean>>;
export type ParsedForm =
	| { ok: true; values: Record<string, unknown> }
	| { ok: false; message: string };

/** Checks the form values of a create against its registered fields and types them. */
export function parseForm(
	fields: readonly FormFieldV1[],
	values: ArtifactEvent["values"],
): ParsedForm {
	const out: Record<string, unknown> = {};
	for (const field of fields) {
		const raw = values[field.fieldId];
		if (field.control === "toggle") {
			out[field.fieldId] = raw === true || raw === "true";
			continue;
		}
		const text = typeof raw === "string" ? raw : "";
		if (!text) {
			if (field.required)
				return { ok: false, message: `${field.label}を入力してください。` };
			continue;
		}
		if (field.maxLength && text.length > field.maxLength)
			return {
				ok: false,
				message: `${field.label}は${field.maxLength}文字以内で入力してください。`,
			};
		if (field.control === "select") {
			const options = field.options;
			if (options && !options.some((o) => o.value === text))
				return {
					ok: false,
					message: `${field.label}を選択肢から選んでください。`,
				};
			if (field.valueType === "number") {
				const number = Number(text);
				if (!Number.isFinite(number))
					return {
						ok: false,
						message: `${field.label}の値を確認してください。`,
					};
				out[field.fieldId] = number;
			} else out[field.fieldId] = text;
		} else if (field.control === "number") {
			const number = Number(text);
			if (
				!Number.isFinite(number) ||
				(field.min !== undefined && number < field.min) ||
				(field.max !== undefined && number > field.max)
			)
				return { ok: false, message: `${field.label}の値を確認してください。` };
			out[field.fieldId] = number;
		} else out[field.fieldId] = text;
	}
	return { ok: true, values: out };
}
