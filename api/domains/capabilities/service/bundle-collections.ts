import type { ArtifactDefinitionV1, FormFieldV1 } from "../contracts";
import { documentOwner, schemaShape, takesInput } from "./bundle-fields";
import type { Check } from "./bundles";

type Artifact = ArtifactDefinitionV1;
type Collection = NonNullable<Artifact["collections"]>[number];

/** The action of this artifact a collection names, with its index for issue paths. */
function findAction(a: Artifact, actionId: string) {
	const index = a.actionBindings.findIndex((x) => x.actionId === actionId);
	return index < 0 ? null : { index, action: a.actionBindings[index]! };
}

/** A form default fits its control; secrets never have one. */
function validFormDefault(field: FormFieldV1) {
	const value = field.defaultValue!;
	if (field.confidential || field.control === "secret") return false;
	switch (field.control) {
		case "toggle":
			return value === "true" || value === "false";
		case "number": {
			const n = Number(value);
			return (
				value.trim() !== "" &&
				Number.isFinite(n) &&
				(field.min === undefined || n >= field.min) &&
				(field.max === undefined || n <= field.max)
			);
		}
		case "select":
			return (
				!field.options?.length || field.options.some((o) => o.value === value)
			);
		default:
			return field.maxLength === undefined || value.length <= field.maxLength;
	}
}

/** Form fields become properties of the action's input; secrets stay declared. */
function checkFormFields(
	c: Check,
	fields: readonly FormFieldV1[],
	action: Artifact["actionBindings"][number],
	adapter: { queries: ReadonlySet<string> } | undefined,
	at: string,
) {
	const shape = schemaShape(c, action.inputSchemaRef);
	fields.forEach((field, k) => {
		const f = `${at}/fields/${k}`;
		if (!shape?.properties.includes(field.fieldId))
			c.issue("schema_mismatch", `${f}/fieldId`, field.fieldId);
		else if (field.required && !shape.required.includes(field.fieldId))
			c.issue("schema_mismatch", `${f}/required`, field.fieldId);
		if (
			field.confidential &&
			!action.confidentialFields?.includes(field.fieldId)
		)
			c.issue("permission", `${f}/confidential`, field.fieldId);
		if (field.optionsSource && field.options)
			c.issue("invalid_format", `${f}/options`);
		if (field.optionsSource && !adapter?.queries.has(field.optionsSource))
			c.issue("unregistered_query", `${f}/optionsSource`, field.optionsSource);
		if (
			field.control === "select" &&
			!field.options?.length &&
			!field.optionsSource
		)
			c.issue("invalid_format", `${f}/options`);
		if (field.defaultValue !== undefined && !validFormDefault(field))
			c.issue("invalid_format", `${f}/defaultValue`, field.defaultValue);
	});
}

/** A row edit form adds its values to the row-built input: no key may come from both. */
function checkRowForm(
	c: Check,
	form: NonNullable<Collection["rowActions"][number]["form"]>,
	action: Artifact["actionBindings"][number],
	adapter: { queries: ReadonlySet<string> } | undefined,
	at: string,
) {
	checkFormFields(c, form.fields, action, adapter, `${at}/form`);
	const ids = new Set(form.fields.map((f) => f.fieldId));
	form.fields.forEach((field, k) => {
		if (action.rowInput && Object.hasOwn(action.rowInput, field.fieldId))
			c.issue(
				"invalid_format",
				`${at}/form/fields/${k}/fieldId`,
				field.fieldId,
			);
	});
	for (const key of Object.keys(form.prefill)) {
		const field = form.fields.find((f) => f.fieldId === key);
		if (!ids.has(key))
			c.issue("invalid_format", `${at}/form/prefill/${key}`, key);
		else if (field?.confidential)
			c.issue("permission", `${at}/form/prefill/${key}`, key);
	}
}

function checkForm(
	c: Check,
	a: Artifact,
	collection: Collection,
	source: Artifact["sourceBindings"][number],
	path: string,
	at: string,
) {
	const create = collection.create;
	if (!create) return;
	const found = findAction(a, create.actionId);
	if (!found) {
		c.issue("unknown_reference", `${at}/create/actionId`, create.actionId);
		return;
	}
	const { action, index } = found;
	if (!takesInput(action))
		c.issue("invalid_format", `${at}/create/actionId`, create.actionId);
	checkFormFields(
		c,
		create.fields,
		action,
		c.host.adapters.get(source.adapterRef),
		`${at}/create`,
	);
	// A secret the form does not collect cannot be declared confidential for it.
	const ids = new Set(create.fields.map((f) => f.fieldId));
	action.confidentialFields?.forEach((name, k) => {
		if (!ids.has(name))
			c.issue(
				"schema_mismatch",
				`${path}/actionBindings/${index}/confidentialFields/${k}`,
				name,
			);
	});
}

/** Whether the artifact edits the document: a registered field or a draft action names it. */
const usesDocument = (a: Artifact, document: string) =>
	a.fields?.some((f) => f.document === document) ||
	a.actionBindings.some((x) => x.draftDocument === document);

/** Collections: a source, row actions built from rows, and a form for the create action. */
export function checkCollections(c: Check, a: Artifact, path: string) {
	a.collections?.forEach((collection, i) => {
		const at = `${path}/collections/${i}`;
		const source = a.sourceBindings.find((s) => s.source === collection.source);
		if (!source) {
			c.issue("unknown_reference", `${at}/source`, collection.source);
			return;
		}
		if (collection.paging && !source.paramsSchemaRef)
			c.issue("invalid_format", `${at}/paging`, collection.source);
		collection.rowActions.forEach((row, k) => {
			const clean = row.requiresCleanDraft;
			if (clean && !documentOwner(c, clean))
				c.issue(
					"unknown_reference",
					`${at}/rowActions/${k}/requiresCleanDraft`,
					clean,
				);
			else if (clean && !usesDocument(a, clean))
				c.issue(
					"invalid_format",
					`${at}/rowActions/${k}/requiresCleanDraft`,
					clean,
				);
			const found = findAction(a, row.actionId);
			if (!found)
				c.issue(
					"unknown_reference",
					`${at}/rowActions/${k}/actionId`,
					row.actionId,
				);
			else if (!takesInput(found.action) || !found.action.rowInput)
				c.issue(
					"invalid_format",
					`${at}/rowActions/${k}/actionId`,
					row.actionId,
				);
			else if (row.form)
				checkRowForm(
					c,
					row.form,
					found.action,
					c.host.adapters.get(source.adapterRef),
					`${at}/rowActions/${k}`,
				);
		});
		checkForm(c, a, collection, source, path, at);
	});
}
