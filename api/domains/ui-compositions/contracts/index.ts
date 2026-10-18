import { z } from "zod";
import {
	compositionDirections,
	compositionViews,
	fixDefinition,
	validateComposition,
} from "@eumenes/artifact-ui/composition-checks";
import { decodeLlmJson } from "../../../infrastructure/llm-json";
import { parseDefinition } from "@eumenes/artifact-ui/contracts";

/** The only views a composition may use. Every other registered view is refused. */
const allowedViews = new Set<string>(["layout", ...compositionViews]);
const allowedDirections = new Set<string>(compositionDirections);
/** Layout keys of the settings screens, never of a composition. */
const settingsLayoutKeys = [
	"tabs",
	"headerChildren",
	"headerLayout",
	"draftSource",
];
export const limits = {
	definitionBytes: 98_304,
	depth: 6,
	views: 240,
	forms: 1,
	/** Undo steps kept for one work (changes after the saved state). */
	changes: 50,
	history: 50,
	/** Saved items offered as a session's starting point (the port allows at most 20). */
	choices: 20,
} as const;
/** The name of the saved form's source inside a saved composition's definition. */
const formSource = "composition-form";

/** A refusal carrying only a safe, lowercase code; `detail` is a short note for repair, never data. */
class UiCompositionError extends Error {
	constructor(
		readonly code: string,
		readonly detail?: string,
	) {
		super(code);
	}
}
export const fail = (code: string, detail?: string): never => {
	throw new UiCompositionError(code, detail);
};

export const submitInput = z.record(
	z.string(),
	z.union([z.string(), z.boolean(), z.array(z.string())]),
);
/** The saved form's fields (the inline `fields` of the definition's one form). */
export const formFields = z
	.array(
		z.strictObject({
			id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
			label: z.string().min(1).max(120),
			type: z.enum([
				"text",
				"textarea",
				"number",
				"select",
				"radio",
				"checkbox",
				"boolean",
			]),
			required: z.boolean().optional(),
			options: z.array(z.string().min(1).max(120)).min(1).max(128).optional(),
			optionLabels: z.record(z.string(), z.string()).optional(),
		}),
	)
	.max(8);
export type FormFields = z.infer<typeof formFields>;
export type Definition = Record<string, unknown>;

const isRecord = (value: unknown): value is Definition =>
	!!value && typeof value === "object" && !Array.isArray(value);

/** Limits and allowlist, independent of the schema the artifact parser enforces. */
function walk(
	node: unknown,
	depth: number,
	count: { views: number; forms: number },
) {
	if (!isRecord(node))
		return fail("ui_definition_invalid", 'every part is an object with "view"');
	if (depth > limits.depth)
		return fail(
			"ui_definition_too_deep",
			`nest layouts at most ${limits.depth} levels including the deepest part`,
		);
	if (++count.views > limits.views)
		return fail(
			"ui_definition_too_many_views",
			`at most ${limits.views} parts in total`,
		);
	if ("source" in node)
		return fail("ui_source_forbidden", "remove every source property");
	const view = node.view;
	if (typeof view !== "string" || !allowedViews.has(view))
		return fail(
			"ui_view_not_allowed",
			`"view" ${JSON.stringify(String(view).slice(0, 40))} is not allowed; use only ${[...allowedViews].join(", ")}`,
		);
	if (view === "layout") {
		if (
			node.direction !== undefined &&
			!allowedDirections.has(node.direction as string)
		)
			return fail(
				"ui_layout_direction_not_allowed",
				`direction must be one of ${[...allowedDirections].join(", ")}`,
			);
		const settingsKey = settingsLayoutKeys.find((key) => key in node);
		if (settingsKey)
			return fail(
				"ui_definition_invalid",
				`remove "${settingsKey}"; tabs take each child's title as its label`,
			);
		if (!Array.isArray(node.children))
			return fail("ui_definition_invalid", "layout needs a children array");
		for (const child of node.children) walk(child, depth + 1, count);
	} else if (view === "form") {
		if (++count.forms > limits.forms)
			return fail(
				"ui_form_limit",
				`at most ${limits.forms} form per definition`,
			);
		if (!Array.isArray(node.fields))
			return fail("ui_definition_invalid", "form needs a fields array");
	}
}
function formOf(node: unknown): Definition | undefined {
	if (!isRecord(node)) return undefined;
	if (node.view === "form") return node;
	if (!Array.isArray(node.children)) return undefined;
	for (const child of node.children) {
		const found = formOf(child);
		if (found) return found;
	}
	return undefined;
}

type Issue = { path: PropertyKey[]; message: string; errors?: Issue[][] };
/**
 * A part is checked against every view's schema, so its union issue alone says "Invalid input".
 * Follow the branch of the part's own view (the one whose `view` matched) down to its first issue.
 */
function partIssue(issue: Issue): Issue {
	const own = issue.errors?.find(
		(branch) =>
			branch.length > 0 &&
			!branch.some((i) => i.path.length === 1 && i.path[0] === "view"),
	);
	if (!own) return issue;
	const inner = partIssue(own[0]!);
	return { ...inner, path: [...issue.path, ...inner.path] };
}

/** An HTML line break the model wrote in a text, which is never HTML: the "\n" it meant. */
const htmlBreak = /<br\s*\/?>/gi;
function withLineBreaks(node: unknown): unknown {
	if (typeof node === "string") return node.replace(htmlBreak, "\n");
	if (Array.isArray(node)) return node.map(withLineBreaks);
	if (!isRecord(node)) return node;
	return Object.fromEntries(
		Object.entries(node).map(([key, value]) => [key, withLineBreaks(value)]),
	);
}

/**
 * A definition the specialist may propose: allowed views only, no `source`, within the size,
 * depth and view-count limits, and valid for the artifact parser. Returns the definition, with
 * any `<br>` in its texts made the line break it meant, and the form's fields.
 */
export function validatedDefinition(input: unknown): {
	definition: Definition;
	fields: FormFields | null;
} {
	const raw = withLineBreaks(input);
	if (!isRecord(raw))
		return fail(
			"ui_definition_invalid",
			'definition is one object with "view"',
		);
	const json = JSON.stringify(raw);
	if (new TextEncoder().encode(json).length > limits.definitionBytes)
		return fail(
			"ui_definition_too_large",
			`keep the definition JSON within ${limits.definitionBytes} bytes`,
		);
	walk(raw, 1, { views: 0, forms: 0 });
	try {
		parseDefinition(json);
	} catch (error) {
		const issue =
			error instanceof z.ZodError && error.issues[0]
				? partIssue(error.issues[0])
				: undefined;
		return fail(
			"ui_definition_invalid",
			issue
				? `${issue.path.join("/").slice(0, 80)}: ${issue.message.slice(0, 120)}`
				: undefined,
		);
	}
	// Meaning: model placement, expressions, references and the types of bound states.
	const meaning = validateComposition(raw);
	if (!meaning.ok)
		return fail(
			"ui_definition_invalid",
			`${meaning.path.slice(0, 80)}: ${meaning.rule}`,
		);
	const form = formOf(raw);
	const fields = form ? formFields.safeParse(form.fields) : null;
	if (fields && !fields.success) {
		const issue = fields.error.issues[0];
		return fail(
			"ui_definition_invalid",
			issue
				? `form/fields/${issue.path.join("/").slice(0, 60)}: ${issue.message.slice(0, 100)}`
				: "form fields",
		);
	}
	return { definition: raw, fields: fields?.success ? fields.data : null };
}
/** The fields of the definition's inline form, or null when it has none. */
export function fieldsOfDefinition(definition: Definition): FormFields | null {
	const parsed = formFields.safeParse(formOf(definition)?.fields);
	return parsed.success ? parsed.data : null;
}

function mapForms(
	node: unknown,
	replace: (form: Definition) => Definition,
): unknown {
	if (!isRecord(node)) return node;
	if (node.view === "form") return replace(node);
	return Array.isArray(node.children)
		? {
				...node,
				children: node.children.map((child) => mapForms(child, replace)),
			}
		: node;
}
/** What a saved composition shows: its form is the answer form fed by the saved fields. */
export function savedRendering(definition: Definition): Definition {
	return mapForms(definition, (form) => ({
		view: "form",
		source: formSource,
		...(form.title !== undefined ? { title: form.title } : {}),
	})) as Definition;
}
/** The editable definition of a saved composition: the answer form is inlined again. */
export function inlineForm(
	definition: Definition,
	fields: FormFields | null,
): Definition {
	return mapForms(definition, (form) => {
		if (form.source !== formSource || !fields?.length) return form;
		const { source: _source, ...rest } = form;
		return { ...rest, fields };
	}) as Definition;
}

/** Keys first in a part (what it is and its heading) and last (what it contains), for a stable reading order. */
const FIRST_KEYS = ["view", "title"];
const LAST_KEYS = ["model", "children", "fields"];
const keyRank = (key: string) =>
	FIRST_KEYS.includes(key)
		? FIRST_KEYS.indexOf(key) - FIRST_KEYS.length
		: LAST_KEYS.includes(key)
			? LAST_KEYS.indexOf(key) + 1
			: 0;
function ordered(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(ordered);
	if (!isRecord(value)) return value;
	return Object.fromEntries(
		Object.keys(value)
			.sort((a, b) => keyRank(a) - keyRank(b) || (a < b ? -1 : a > b ? 1 : 0))
			.map((key) => [key, ordered(value[key])]),
	);
}
/**
 * The definition's canonical text (spec subagent-task-and-session-agents §7.2): keys in a fixed order (`view`
 * and `title` first, `model`, `children` and `fields` last, the rest by name) and two-space indentation. The
 * same definition always gives the same text; the screen's source view and the specialist read this text.
 */
export function canonicalText(definition: Definition): string {
	return JSON.stringify(ordered(definition), null, 2);
}

export type DefinitionIssue = { path: string; rule: string };
/**
 * A definition's text as the work document's next value: read (one syntax correction at the model's boundary),
 * fixed by the composition fixer (it drops what it cannot show and records it), then checked strictly. A
 * refusal says where and by which rule, never the values.
 */
export function checkDefinitionText(
	text: string,
):
	| { ok: true; definition: Definition; fields: FormFields | null; fixes: string[] }
	| { ok: false; code: string; issues: DefinitionIssue[]; fixes: string[] } {
	let raw: unknown;
	try {
		raw = decodeLlmJson(text, limits.definitionBytes * 2).value;
	} catch (error) {
		const code = (error as { code?: unknown }).code;
		return {
			ok: false,
			code: "document_parse_failed",
			issues: [
				{ path: "(root)", rule: typeof code === "string" ? code : "json" },
			],
			fixes: [],
		};
	}
	const fixed = fixDefinition(raw);
	if (!fixed.ok)
		return {
			ok: false,
			code: "ui_definition_invalid",
			issues: [{ path: "(root)", rule: "nothing_displayable" }],
			fixes: fixed.fixes,
		};
	try {
		const checked = validatedDefinition(fixed.definition);
		return { ok: true, ...checked, fixes: fixed.fixes };
	} catch (error) {
		if (!(error instanceof UiCompositionError)) throw error;
		const detail = error.detail ?? "";
		const at = detail.indexOf(": ");
		return {
			ok: false,
			code: error.code,
			issues: [
				at >= 0
					? { path: detail.slice(0, at) || "(root)", rule: detail.slice(at + 2) }
					: { path: "(root)", rule: detail || error.code },
			],
			fixes: fixed.fixes,
		};
	}
}
