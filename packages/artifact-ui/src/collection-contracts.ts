import type { TableQuery } from "@eumenes/design-system";

/** One action offered on a row; the host decides which rows get it and what it sends. */
export type CollectionRowAction = {
	actionId: string;
	label: string;
	/** Asked before the action is sent (e.g. a delete). */
	confirm?: string;
	destructive?: boolean;
	disabled?: boolean;
	/** Why the action is unavailable right now (shown beside it). */
	hint?: string;
	/**
	 * A digest of the row values the action's input and form start from. The view sends back
	 * the one it held when the dialog opened; the host refuses it if the row has changed since.
	 */
	guard?: string;
	/** Opens a form for the row first; `values` are the host's prefill from the row. */
	form?: {
		fields: CollectionFormField[];
		values: Record<string, string | boolean>;
	};
};
export type CollectionRow = {
	id: string;
	/** Displayed text per column key. */
	cells: Record<string, string>;
	/** Media columns: a same-origin `/api/` path and its mime type (fetched on demand). */
	media?: Record<string, { path: string; mime: string }>;
	actions: CollectionRowAction[];
};
export type CollectionFormField = {
	id: string;
	label: string;
	help?: string;
	control: "text" | "textarea" | "select" | "toggle" | "number" | "secret";
	options?: { value: string; label: string }[];
	maxLength?: number;
	required?: boolean;
	/** The value the form starts with (a toggle takes "true"/"false"). */
	defaultValue?: string;
};

/**
 * A list over an adapter query with row actions and a create form. The host builds it from the
 * artifact registration and the source data; the view only shows it and reports events.
 */
export type CollectionResource = {
	kind: "collection";
	revision: number;
	title?: string;
	/** A short note shown above the table. */
	description?: string;
	columns: Array<{ key: string; label: string; media?: true }>;
	rows: CollectionRow[];
	total: number;
	/** Present when the source pages, sorts and searches by params. */
	paging?: TableQuery;
	create?: { actionId: string; label: string; fields: CollectionFormField[] };
	busy?: boolean;
	message?: string;
	error?: string;
	emptyMessage?: string;
};
