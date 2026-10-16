import type { FormResource } from "./contracts";

/** Source name the studio gives the draft's trial form (never a host source). */
export const trialFormSource = "trial-form";
/** Source of a saved work's form: submissions go to the host's answer route. */
export const savedFormSource = "composition-form";

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
	!!value && typeof value === "object" && !Array.isArray(value);
const isInlineForm = (value: Json) =>
	value.view === "form" && Array.isArray(value.fields) && !value.source;

function mapForms(node: unknown, replace: (form: Json) => Json): unknown {
	if (!isObject(node)) return node;
	if (isInlineForm(node)) return replace(node);
	if (node.view === "layout" && Array.isArray(node.children))
		return {
			...node,
			children: node.children.map((child) => mapForms(child, replace)),
		};
	return node;
}
function firstForm(node: unknown): Json | null {
	if (!isObject(node)) return null;
	if (isInlineForm(node)) return node;
	if (node.view === "layout" && Array.isArray(node.children))
		for (const child of node.children) {
			const found = firstForm(child);
			if (found) return found;
		}
	return null;
}

/** True when the definition holds a form, inline or bound to a source. */
export function hasForm(node: unknown): boolean {
	if (!isObject(node)) return false;
	if (node.view === "form") return true;
	return (
		node.view === "layout" &&
		Array.isArray(node.children) &&
		node.children.some(hasForm)
	);
}

/**
 * The draft's preview: its inline form becomes a trial form on a studio-owned source. Its
 * submit is answered inside the studio, so nothing is recorded as a response.
 */
export function trialPreview(definition: unknown): {
	definition: unknown;
	form: FormResource | null;
} {
	const form = firstForm(definition);
	if (!form) return { definition, form: null };
	return {
		definition: mapForms(definition, (inline) => ({
			view: "form",
			source: trialFormSource,
			...(typeof inline.title === "string" ? { title: inline.title } : {}),
		})),
		form: {
			kind: "form",
			revision: 0,
			submitLabel: "送信（試用）",
			fields: form.fields as FormResource["fields"],
			defaults: {},
		},
	};
}

/** A saved work shows its form from the host's `composition-form` source with a real submit. */
export function savedPreview(definition: unknown): unknown {
	return mapForms(definition, (inline) => ({
		view: "form",
		source: savedFormSource,
		...(typeof inline.title === "string" ? { title: inline.title } : {}),
	}));
}
