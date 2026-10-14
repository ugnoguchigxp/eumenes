import type { SettingsChangeRow } from "@eumenes/design-system";
import type { DocumentFieldV1 } from "../../../../api/domains/capabilities/contracts";
import {
	entryKey,
	sameChange,
	type DraftEntry,
	type DraftView,
	type FieldChange,
	type JsonValue,
} from "./drafts";

/** A field of an adapter document together with the screen that registered it. */
export type RegisteredField = DocumentFieldV1 & {
	/** The registering screen's name, used as the review row prefix ("表示 / テーマ"). */
	section: string;
	/** The published revision of the screen that registered the field (its sources). */
	artifactRevisionId: string;
	/** That screen's sources, to read the field's `optionsSource` where it was registered. */
	sources: ReadonlyArray<{ source: string; query: string }>;
};

/** The limits in force for one field right now (registered ones, narrowed by the adapter). */
export type FieldRule = {
	options?: ReadonlyArray<{ value: string; label: string }>;
	min?: number;
	max?: number;
	step?: number;
	maxLength?: number;
	/** Shown when the document holds no value (an optional key); not a saved value. */
	defaultValue?: string;
	/** Shown but not editable right now (its choices are not available yet). */
	disabled?: boolean;
};

/** The adapter's saved copy of one document and the rules it applies to its fields. */
export type DocumentAccess = {
	ready: boolean;
	/** The saved revision; `expectedRevision` of an apply. */
	revision: number;
	/** The saved value, or undefined when the key is absent. */
	read(field: DocumentFieldV1, target?: string): JsonValue | undefined;
	/** The current limits, or null while the field is hidden or unavailable (edits refused). */
	rule(field: DocumentFieldV1, target?: string): FieldRule | null;
	/** Array elements a field with a `target` applies to. */
	targets(field: DocumentFieldV1): ReadonlyArray<{ id: string; label: string }>;
	/**
	 * Structural operations an apply must carry because the user has to confirm them (e.g. a
	 * new origin for a connection that holds credentials). The host asks `prompt` first.
	 */
	confirmations?(dirty: ReadonlyArray<Resolved>): ReadonlyArray<{
		structure: string;
		input: Record<string, unknown>;
		prompt: string;
		/** Said when the user declines. */
		declined: string;
	}>;
	/** Other fields an edit implies (by document path), e.g. a new voice resets its style. */
	derive?(
		field: DocumentFieldV1,
		target: string | undefined,
		change: FieldChange,
	): ReadonlyArray<{ path: string; change: FieldChange }>;
};

export function ruleOf(field: DocumentFieldV1): FieldRule {
	return {
		options: field.options,
		min: field.min,
		max: field.max,
		step: field.step,
		maxLength: field.maxLength,
	};
}

/** The text a screen control carries for a value. */
export function toWire(value: JsonValue | undefined): string {
	if (value === undefined || value === null) return "";
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean")
		return String(value);
	return JSON.stringify(value);
}

export type ParsedEdit =
	| { ok: true; change: FieldChange }
	| { ok: false; message: string };

const refuse = (message: string): ParsedEdit => ({ ok: false, message });

/** Checks the text of an edit against the field and converts it to a typed change. */
export function parseWire(
	field: DocumentFieldV1,
	rule: FieldRule,
	wire: unknown,
): ParsedEdit {
	if (typeof wire !== "string") return refuse("入力の型を確認してください");
	if (wire === "" && field.unset) return { ok: true, change: { unset: true } };
	switch (field.control) {
		case "toggle":
			return wire === "true" || wire === "false"
				? { ok: true, change: { value: wire === "true" } }
				: refuse("オンかオフを選んでください");
		case "range":
		case "number": {
			if (!wire.trim() || !Number.isFinite(Number(wire)))
				return refuse("数値で入力してください");
			const number = Number(wire);
			if (
				(rule.min !== undefined && number < rule.min) ||
				(rule.max !== undefined && number > rule.max)
			)
				return refuse("入力できる範囲を確認してください");
			if (
				rule.step !== undefined &&
				rule.step >= 1 &&
				!Number.isInteger(number)
			)
				return refuse("整数で入力してください");
			return { ok: true, change: { value: number } };
		}
		case "select": {
			if (!rule.options?.some((o) => o.value === wire))
				return refuse("選択肢から選んでください");
			return { ok: true, change: { value: wire } };
		}
		case "multiple": {
			let list: unknown;
			try {
				list = JSON.parse(wire);
			} catch {
				return refuse("選択の形式を確認してください");
			}
			if (
				!Array.isArray(list) ||
				list.length === 0 ||
				list.some(
					(item) =>
						typeof item !== "string" ||
						!rule.options?.some((o) => o.value === item),
				) ||
				new Set(list).size !== list.length
			)
				return refuse("選択肢から1つ以上選んでください");
			return { ok: true, change: { value: list as string[] } };
		}
		default:
			if (wire.length > (rule.maxLength ?? field.maxLength ?? 4096))
				return refuse("文字数の上限を超えています");
			return { ok: true, change: { value: wire } };
	}
}

const absent = (value: JsonValue | undefined) =>
	value === undefined || value === null;

/** Is the change what the document already holds? An unset change equals an absent key. */
export function equalsSaved(
	change: FieldChange,
	saved: JsonValue | undefined,
): boolean {
	if ("unset" in change) return absent(saved) || saved === "";
	return JSON.stringify(change.value) === JSON.stringify(saved);
}

export function changeToWire(change: FieldChange): string {
	return "unset" in change ? "" : toWire(change.value);
}

export type Resolved = {
	entry: DraftEntry;
	field: RegisteredField | undefined;
	saved: JsonValue | undefined;
};

/**
 * The entries that differ from the saved document. An entry whose field is not (yet) known is
 * kept as dirty: it was edited, and the review must show it rather than hide it.
 */
export function dirtyEntries(
	view: Pick<DraftView, "entries">,
	fields: ReadonlyArray<RegisteredField>,
	access: DocumentAccess | undefined,
): Resolved[] {
	const byId = new Map(fields.map((f) => [f.fieldId, f] as const));
	return view.entries
		.map((entry): Resolved => {
			const field = byId.get(entry.fieldId);
			return {
				entry,
				field,
				saved: field ? access?.read(field, entry.target) : undefined,
			};
		})
		.filter(({ entry, field, saved }) =>
			field ? !equalsSaved(entry.change, saved) : true,
		);
}

function displayOf(
	field: RegisteredField | undefined,
	rule: FieldRule | null | undefined,
	value: JsonValue | undefined,
	defaultLabel: string,
): string {
	if (absent(value) || value === "") return defaultLabel;
	if (field?.control === "toggle") return value === true ? "オン" : "オフ";
	const options = rule?.options ?? field?.options;
	const label = (v: JsonValue) =>
		options?.find((o) => o.value === String(v))?.label ?? String(v);
	if (Array.isArray(value)) return value.map(label).join("、");
	return label(value);
}

/**
 * The review rows of a draft: registered fields only, saved value against draft value.
 * Secrets appear as a count and never as values.
 */
export function reviewRows(
	view: DraftView,
	fields: ReadonlyArray<RegisteredField>,
	access: DocumentAccess | undefined,
	/** The screens registering the fields are all read; until then unknown rows stay hidden. */
	ready = true,
): SettingsChangeRow[] {
	const rows: SettingsChangeRow[] = dirtyEntries(view, fields, access)
		.filter(({ field }) => field || ready)
		.map(({ entry, field, saved }) => {
			const target = entry.target
				? access?.targets(field!).find((t) => t.id === entry.target)
				: undefined;
			const rule = field ? access?.rule(field, entry.target) : undefined;
			return {
				id: entryKey(entry.fieldId, entry.target),
				label: field
					? `${field.section} / ${target ? `${target.label} の` : ""}${field.label}`
					: `未登録の項目 / ${entry.fieldId}`,
				before: displayOf(field, rule, saved, "サービスの標準"),
				after:
					"unset" in entry.change
						? "サービスの標準"
						: displayOf(field, rule, entry.change.value, "サービスの標準"),
			};
		});
	rows.unshift(
		...view.structural.map((entry) => ({
			id: `structure:${entry.id}`,
			label: "構成の変更",
			before: "現在の構成",
			after: entry.label,
		})),
	);
	if (view.secrets.length)
		rows.push({
			id: "credentials",
			label: "認証情報",
			before: "現在の認証情報",
			after: `更新・削除予定 ${view.secrets.length}件`,
		});
	return rows;
}

export { sameChange };
