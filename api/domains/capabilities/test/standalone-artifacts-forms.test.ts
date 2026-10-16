import { expect, test } from "bun:test";
import type { BundleIssue } from "..";
import {
	action,
	artifact,
	bundle,
	fixture,
	lines,
} from "./standalone-artifacts.fixture";

const addSchema = {
	kind: "schema",
	id: "notes-add",
	revision: 1,
	schema: {
		type: "object",
		additionalProperties: false,
		required: ["name"],
		properties: {
			name: { type: "string", maxLength: 20 },
			apiKey: { type: "string", maxLength: 100 },
			kind: { type: "string", maxLength: 10 },
			rowId: { type: "string", maxLength: 40 },
			revision: { type: "integer", minimum: 0 },
		},
	},
};
const structureAction = (over: Record<string, unknown> = {}) =>
	action({
		actionId: "add-note",
		eventAction: "add-note",
		effect: "draft",
		draftAction: "structure",
		structure: "structure:notes.add@1",
		draftDocument: "document:notes@1",
		inputSchemaRef: "schema:notes-add@1",
		label: "追加",
		...over,
	});
const removeAction = (over: Record<string, unknown> = {}) =>
	action({
		actionId: "remove-note",
		eventAction: "remove-note",
		source: "notes-items",
		effect: "write",
		operationId: "notes.remove",
		inputSchemaRef: "schema:notes-add@1",
		rowInput: {
			rowId: "$row.id",
			revision: "$row.revision",
			name: { literal: "x" },
		},
		...over,
	});
const collection = (over: Record<string, unknown> = {}) => ({
	source: "notes-items",
	title: "一覧",
	rowKey: "id",
	columns: [{ key: "name", label: "名前" }],
	rowActions: [{ actionId: "remove-note", confirm: "削除しますか" }],
	create: {
		actionId: "add-note",
		fields: [
			{ fieldId: "name", label: "名前", control: "text", required: true },
			{
				fieldId: "apiKey",
				label: "キー",
				control: "secret",
				confidential: true,
			},
		],
	},
	paging: true,
	...over,
});
/** A collections artifact: the add form stages a structure; rows can be removed. */
const listing = (
	over: {
		collection?: Record<string, unknown>;
		actions?: unknown[];
		sources?: boolean;
		draftDependencies?: string[];
	} = {},
) =>
	artifact("a", 1, {
		fields: [],
		...(over.draftDependencies
			? { draftDependencies: over.draftDependencies }
			: {}),
		sourceBindings: artifact("a", 1).sourceBindings.map((s) =>
			s.source === "notes-items" && over.sources !== false
				? { ...s, paramsSchemaRef: "builtin:emptyInput" }
				: s,
		),
		actionBindings: over.actions ?? [
			structureAction({ confidentialFields: ["apiKey"] }),
			removeAction(),
		],
		collections: [collection(over.collection)],
	});
const checkListing = async (
	load: (raw: unknown, dryRun?: boolean) => Promise<{ issues: BundleIssue[] }>,
	over: Parameters<typeof listing>[0] = {},
) => lines(await load(bundle([listing(over)], "notes", [addSchema]), true));

test("structure actions must be registered by the document's adapter with its input schema", async () => {
	await fixture(async ({ load }) => {
		expect(await checkListing(load)).toEqual([]);
		const check = (over: Record<string, unknown>) =>
			checkListing(load, {
				actions: [
					structureAction({ confidentialFields: ["apiKey"], ...over }),
					removeAction(),
				],
			});
		const at = "artifacts/0/actionBindings/0";
		expect(await check({ structure: "structure:notes.nothing@1" })).toEqual([
			`unknown_reference:${at}/structure`,
		]);
		expect(
			await check({
				inputSchemaRef: "builtin:emptyInput",
				confidentialFields: undefined,
			}),
		).toContain(`schema_mismatch:${at}/inputSchemaRef`);
	});
});

test("collection sources, paging and row actions are checked against this artifact's bindings", async () => {
	await fixture(async ({ load }) => {
		const at = "artifacts/0/collections/0";
		expect(
			await checkListing(load, { collection: { source: "nothing" } }),
		).toEqual([`unknown_reference:${at}/source`]);
		expect(await checkListing(load, { sources: false })).toEqual([
			`invalid_format:${at}/paging`,
		]);
		expect(
			await checkListing(load, {
				collection: { rowActions: [{ actionId: "nothing" }] },
			}),
		).toEqual([`unknown_reference:${at}/rowActions/0/actionId`]);
		// A row action needs a write action that builds its input from the row.
		expect(
			await checkListing(load, {
				actions: [
					structureAction({ confidentialFields: ["apiKey"] }),
					removeAction({ rowInput: undefined }),
				],
			}),
		).toEqual([`invalid_format:${at}/rowActions/0/actionId`]);
		expect(
			await checkListing(load, {
				collection: { rowActions: [{ actionId: "add-note" }] },
			}),
		).toEqual([`invalid_format:${at}/rowActions/0/actionId`]);
	});
});

test("row input keys must be top-level properties of the action's input, on write and structure actions only", async () => {
	await fixture(async ({ load }) => {
		const at = "artifacts/0/actionBindings/1";
		expect(
			await checkListing(load, {
				actions: [
					structureAction({ confidentialFields: ["apiKey"] }),
					removeAction({ rowInput: { nothing: "$row.id" } }),
				],
			}),
		).toEqual([`schema_mismatch:${at}/rowInput/nothing`]);
		expect(
			await checkListing(load, {
				actions: [
					structureAction({ confidentialFields: ["apiKey"] }),
					removeAction(),
					structureAction({
						actionId: "edit-note",
						eventAction: "edit-note",
						draftAction: "edit",
						structure: undefined,
						rowInput: { name: "$row.id" },
					}),
				],
			}),
		).toEqual(["invalid_format:artifacts/0/actionBindings/2/rowInput"]);
	});
});

test("the create form must match the action input and keep secrets declared", async () => {
	await fixture(async ({ load }) => {
		const at = "artifacts/0/collections/0/create";
		const form = (fields: unknown[], actions?: unknown[]) =>
			checkListing(load, {
				collection: { create: { actionId: "add-note", fields } },
				actions,
			});
		const name = {
			fieldId: "name",
			label: "名前",
			control: "text",
			required: true,
		};
		const key = {
			fieldId: "apiKey",
			label: "キー",
			control: "secret",
			confidential: true,
		};
		expect(await form([name, key])).toEqual([]);
		expect(
			await checkListing(load, {
				collection: { create: { actionId: "nothing", fields: [name] } },
			}),
		).toEqual([`unknown_reference:${at}/actionId`]);
		// Another kind of action cannot be created from.
		expect(
			await checkListing(load, {
				collection: { create: { actionId: "settings-edit", fields: [name] } },
				actions: [
					action({
						actionId: "settings-edit",
						eventAction: "settings-edit",
						effect: "draft",
						draftAction: "edit",
						draftDocument: "document:notes@1",
						inputSchemaRef: "schema:notes-add@1",
					}),
					removeAction(),
				],
			}),
		).toEqual([`invalid_format:${at}/actionId`]);
		// Fields are input properties; required ones are required there.
		expect(await form([{ ...name, fieldId: "other" }])).toEqual([
			`schema_mismatch:${at}/fields/0/fieldId`,
			"schema_mismatch:artifacts/0/actionBindings/0/confidentialFields/0",
		]);
		expect(await form([name, { ...key, required: true }])).toEqual([
			`schema_mismatch:${at}/fields/1/required`,
		]);
		// A secret is listed in the action's confidentialFields, and only form fields are.
		expect(
			await form([name, key], [structureAction(), removeAction()]),
		).toEqual([`permission:${at}/fields/1/confidential`]);
		expect(
			await form(
				[name],
				[structureAction({ confidentialFields: ["apiKey"] }), removeAction()],
			),
		).toEqual([
			"schema_mismatch:artifacts/0/actionBindings/0/confidentialFields/0",
		]);
		// A write action can be the create action too.
		expect(
			await checkListing(load, {
				collection: { create: { actionId: "remove-note", fields: [name] } },
			}),
		).toEqual([]);
	});
});

test("form options come from fixed values or a registered query of the source's adapter", async () => {
	await fixture(async ({ load }) => {
		const at = "artifacts/0/collections/0/create/fields/0";
		const field = (over: Record<string, unknown>) =>
			checkListing(load, {
				collection: {
					create: {
						actionId: "add-note",
						fields: [
							{
								fieldId: "name",
								label: "名前",
								control: "select",
								required: true,
								...over,
							},
						],
					},
				},
				actions: [structureAction(), removeAction()],
			});
		expect(await field({ options: [{ value: "a", label: "A" }] })).toEqual([]);
		expect(await field({ optionsSource: "query:notes.choices@1" })).toEqual([]);
		expect(await field({})).toEqual([`invalid_format:${at}/options`]);
		expect(await field({ optionsSource: "query:other.document@1" })).toEqual([
			`unregistered_query:${at}/optionsSource`,
		]);
		expect(
			await field({
				optionsSource: "query:notes.choices@1",
				options: [{ value: "a", label: "A" }],
			}),
		).toEqual([`invalid_format:${at}/options`]);
	});
});

test("a row edit form adds fields to the row-built input without overlapping it", async () => {
	await fixture(async ({ load }) => {
		const at = "artifacts/0/collections/0/rowActions/0/form";
		const kind = { fieldId: "kind", label: "種類", control: "text" };
		const secret = {
			fieldId: "apiKey",
			label: "キー",
			control: "secret",
			confidential: true,
		};
		const edit = (
			form: Record<string, unknown>,
			action: Record<string, unknown> = {},
		) =>
			checkListing(load, {
				collection: { rowActions: [{ actionId: "remove-note", form }] },
				actions: [
					structureAction({ confidentialFields: ["apiKey"] }),
					removeAction(action),
				],
			});
		expect(
			await edit({ fields: [kind], prefill: { kind: "$row.kind" } }),
		).toEqual([]);
		// Form fields are input properties, and required ones are required there.
		expect(
			await edit({ fields: [{ ...kind, fieldId: "other" }], prefill: {} }),
		).toEqual([`schema_mismatch:${at}/fields/0/fieldId`]);
		expect(
			await edit({ fields: [{ ...kind, required: true }], prefill: {} }),
		).toEqual([`schema_mismatch:${at}/fields/0/required`]);
		// A key already built from the row cannot also be typed.
		expect(
			await edit({ fields: [{ ...kind, fieldId: "rowId" }], prefill: {} }),
		).toEqual([`invalid_format:${at}/fields/0/fieldId`]);
		// Prefill fills form fields only.
		expect(
			await edit({ fields: [kind], prefill: { rowId: "$row.id" } }),
		).toEqual([`invalid_format:${at}/prefill/rowId`]);
		// Secrets are declared and never prefilled.
		expect(await edit({ fields: [secret], prefill: {} })).toEqual([
			`permission:${at}/fields/0/confidential`,
		]);
		expect(
			await edit(
				{ fields: [secret], prefill: {} },
				{ confidentialFields: ["apiKey"] },
			),
		).toEqual([]);
		expect(
			await edit(
				{ fields: [secret], prefill: { apiKey: "$row.apiKey" } },
				{ confidentialFields: ["apiKey"] },
			),
		).toEqual([`permission:${at}/prefill/apiKey`]);
		// Choices follow the same rule as the create form.
		expect(
			await edit({ fields: [{ ...kind, control: "select" }], prefill: {} }),
		).toEqual([`invalid_format:${at}/fields/0/options`]);
		expect(
			await edit({
				fields: [
					{
						...kind,
						control: "select",
						optionsSource: "query:other.document@1",
					},
				],
				prefill: {},
			}),
		).toEqual([`unregistered_query:${at}/fields/0/optionsSource`]);
	});
});

test("form defaults fit their control, and refresh-while keeps to an existing source", async () => {
	await fixture(async ({ load }) => {
		const at = "artifacts/0/collections/0/create/fields/0";
		const field = (over: Record<string, unknown>) =>
			checkListing(load, {
				collection: {
					create: {
						actionId: "add-note",
						fields: [
							{
								fieldId: "name",
								label: "名前",
								control: "text",
								required: true,
								...over,
							},
						],
					},
				},
				actions: [structureAction(), removeAction()],
			});
		const bad = [`invalid_format:${at}/defaultValue`];
		expect(await field({ defaultValue: "x" })).toEqual([]);
		expect(
			await field({ defaultValue: "x".repeat(21), maxLength: 20 }),
		).toEqual(bad);
		expect(await field({ control: "toggle", defaultValue: "true" })).toEqual(
			[],
		);
		expect(await field({ control: "toggle", defaultValue: "on" })).toEqual(bad);
		const number = { control: "number", min: 1, max: 5 };
		expect(await field({ ...number, defaultValue: "3" })).toEqual([]);
		expect(await field({ ...number, defaultValue: "6" })).toEqual(bad);
		expect(await field({ ...number, defaultValue: "x" })).toEqual(bad);
		const select = { control: "select", options: [{ value: "a", label: "A" }] };
		expect(await field({ ...select, defaultValue: "a" })).toEqual([]);
		expect(await field({ ...select, defaultValue: "b" })).toEqual(bad);
		expect(
			await field({
				control: "select",
				optionsSource: "query:notes.choices@1",
				defaultValue: "any",
			}),
		).toEqual([]);
		// Secrets never have a default.
		expect(
			await field({ control: "secret", confidential: true, defaultValue: "x" }),
		).toContain(`invalid_format:${at}/defaultValue`);
		const refresh = { key: "state", in: ["running"] };
		expect(
			await checkListing(load, { collection: { refreshWhile: refresh } }),
		).toEqual([]);
		expect(
			await checkListing(load, {
				collection: { refreshWhile: refresh, source: "nothing" },
			}),
		).toEqual(["unknown_reference:artifacts/0/collections/0/source"]);
	});
});

test("structure actions can be row actions and create actions, and ids may be generated", async () => {
	await fixture(async ({ load }) => {
		const generated = { rowId: { generate: "uuid" }, name: { literal: "x" } };
		const staged = (over: Record<string, unknown> = {}) =>
			structureAction({
				rowInput: generated,
				confidentialFields: ["apiKey"],
				...over,
			});
		const check = (over: Parameters<typeof listing>[0]) =>
			checkListing(load, over);
		// A draft structure action with rowInput is a row action ...
		expect(
			await check({
				collection: { rowActions: [{ actionId: "add-note" }] },
				actions: [staged(), removeAction()],
			}),
		).toEqual([]);
		// ... and the create action, with generated ids next to the typed fields.
		expect(await check({ actions: [staged(), removeAction()] })).toEqual([]);
		// Without rowInput it is not a row action.
		expect(
			await check({
				collection: { rowActions: [{ actionId: "add-note" }] },
			}),
		).toEqual([
			"invalid_format:artifacts/0/collections/0/rowActions/0/actionId",
		]);
		// A generated key must be an input property.
		expect(
			await check({
				actions: [
					staged({ rowInput: { nothing: { generate: "uuid" } } }),
					removeAction(),
				],
			}),
		).toEqual([
			"schema_mismatch:artifacts/0/actionBindings/0/rowInput/nothing",
		]);
		// rowInput is for write and structure actions only.
		expect(
			await check({
				actions: [
					staged(),
					removeAction(),
					action({
						actionId: "open",
						eventAction: "open",
						effect: "navigate",
						navigateTo: { artifactId: "b" },
						inputSchemaRef: "schema:notes-add@1",
						rowInput: { rowId: "$row.id" },
					}),
				],
			}),
		).toEqual(["invalid_format:artifacts/0/actionBindings/2/rowInput"]);
	});
});

test("a clean-draft requirement names a registered document that the artifact uses", async () => {
	await fixture(async ({ load }) => {
		const at = "artifacts/0/collections/0/rowActions/0/requiresCleanDraft";
		const clean = (
			document: string,
			over: Parameters<typeof listing>[0] = {},
		) =>
			checkListing(load, {
				collection: {
					rowActions: [
						{ actionId: "remove-note", requiresCleanDraft: document },
					],
				},
				...over,
			});
		// The listing's draft actions use the notes document.
		expect(await clean("document:notes@1")).toEqual([]);
		expect(await clean("document:nothing@1")).toEqual([
			`unknown_reference:${at}`,
		]);
		// Registered by an adapter but not used by this artifact.
		expect(await clean("document:other@1")).toEqual([`invalid_format:${at}`]);
		// A read-only dependency lets an action wait for another document's draft.
		expect(
			await clean("document:other@1", {
				draftDependencies: ["document:other@1"],
			}),
		).toEqual([]);
		// A registered field counts as use, without any draft action.
		const field = {
			...(artifact("x", 1).fields![0] as object),
			document: "document:other@1",
			path: "$.anything",
		};
		expect(
			await clean("document:other@1", {
				actions: [
					structureAction({
						draftDocument: "document:notes@1",
						confidentialFields: ["apiKey"],
					}),
					removeAction(),
				],
			}),
		).toEqual([`invalid_format:${at}`]);
		expect(
			lines(
				await load(
					bundle(
						[
							artifact("a", 1, {
								sourceBindings: artifact("a", 1).sourceBindings.map((s) =>
									s.source === "notes-items"
										? { ...s, paramsSchemaRef: "builtin:emptyInput" }
										: s,
								),
								fields: [{ ...field, fieldId: "a.other", control: "text" }],
								actionBindings: [
									structureAction({ confidentialFields: ["apiKey"] }),
									removeAction(),
								],
								collections: [
									collection({
										rowActions: [
											{
												actionId: "remove-note",
												requiresCleanDraft: "document:other@1",
											},
										],
									}),
								],
							}),
						],
						"notes",
						[addSchema],
					),
					true,
				),
			),
		).toEqual([]);
		// The media column format needs nothing else.
		expect(
			await checkListing(load, {
				collection: {
					columns: [{ key: "image", label: "画像", format: "media" }],
				},
			}),
		).toEqual([]);
	});
});
