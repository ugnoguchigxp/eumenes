import { z } from "zod";
import {
	compositionDirections,
	compositionViews,
	validateComposition,
} from "@eumenes/artifact-ui/composition-checks";
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
