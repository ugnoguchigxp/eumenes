import type { TableQuery } from "@eumenes/design-system";

/** One action offered on a row; the host decides which rows get it and what it sends. */
export type CollectionRowAction = {
	actionId: string;
	label: string;
	/** Asked before the action is sent (e.g. a delete). */
	confirm?: string;
	destructive?: boolean;
	disabled?: boolean;
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
	columns: Array<{ key: string; label: string }>;
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
