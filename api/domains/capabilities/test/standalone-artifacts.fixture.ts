import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../../infrastructure/sqlite";
import {
	createCapabilities,
	migrations,
	type BundleHost,
	type DocumentDescription,
	type DocumentPathInfo,
	type BundleIssue,
} from "..";

const infos: Record<string, DocumentPathInfo> = {
	"$.general.theme": {
		kind: "enum",
		values: ["light", "dark"],
		optional: false,
		nullable: false,
	},
	"$.general.volume": {
		kind: "integer",
		min: 0,
		max: 10,
		optional: true,
		nullable: false,
	},
	"$.general.enabled": { kind: "boolean", optional: false, nullable: false },
	"$.general.tags": {
		kind: "array",
		values: ["a", "b"],
		optional: true,
		nullable: false,
	},
	"$.general.name": {
		kind: "string",
		maxLength: 20,
		optional: true,
		nullable: true,
	},
	"$.general.apiKey": {
		kind: "string",
		maxLength: 100,
		optional: true,
		nullable: false,
	},
	"$.items[id=$target].voice": {
		kind: "string",
		maxLength: 50,
		optional: true,
		nullable: true,
	},
};
const notes: DocumentDescription = {
	describePath: (p) => infos[p] ?? null,
	targetQuery: (p) =>
		p.includes("[id=$target]") ? "query:notes.items@1" : null,
};
export const host = (): BundleHost => ({
	adapters: new Map([
		[
			"adapter:notes@1",
			{
				operations: new Map([
					["notes.apply", { inputSchemaRef: "builtin:emptyInput" }],
					["notes.other", { inputSchemaRef: "builtin:emptyInput" }],
					["notes.remove", { inputSchemaRef: "schema:notes-add@1" }],
				]),
				queries: new Set([
					"query:notes.document@1",
					"query:notes.items@1",
					"query:notes.choices@1",
				]),
				documents: new Map([["document:notes@1", notes]]),
				conditions: new Set(["condition:notes-voice@1"]),
				structures: new Map([
					["structure:notes.add@1", { inputSchemaRef: "schema:notes-add@1" }],
				]),
			},
		],
		[
			"adapter:other@1",
			{
				operations: new Map([
					["other.apply", { inputSchemaRef: "builtin:emptyInput" }],
				]),
				queries: new Set(["query:other.document@1"]),
				documents: new Map([
					[
						"document:other@1",
						{
							describePath: (): DocumentPathInfo => ({
								kind: "string",
								optional: true,
								nullable: false,
							}),
						},
					],
				]),
			},
		],
	]),
	availability: new Set(),
	inputAdapters: new Set(),
	projections: new Set(),
	domainSchemas: new Set(),
	connections: new Set(),
});

export const action = (over: Record<string, unknown>) => ({
	actionId: "x",
	eventAction: "x",
	source: "notes-doc",
	inputSchemaRef: "builtin:emptyInput",
	effect: "local",
	...over,
});
/** A standalone artifact over the notes document with draft, apply and navigate actions. */
export const artifact = (
	id: string,
	revision: number,
	over: Record<string, unknown> = {},
) => ({
	kind: "artifact",
	id,
	revision,
	title: `画面 ${id} ${revision}`,
	variants: [
		{
			id: "standard",
			label: "標準",
			definition: { view: "settings-section", source: "notes-doc" },
		},
	],
	defaultVariant: "standard",
	sourceBindings: [
		{
			source: "notes-doc",
			adapterRef: "adapter:notes@1",
			query: "query:notes.document@1",
			target: "none",
		},
		{
			source: "notes-items",
			adapterRef: "adapter:notes@1",
			query: "query:notes.items@1",
			target: "none",
		},
	],
	actionBindings: [
		action({
			actionId: "settings-edit",
			eventAction: "settings-edit",
			effect: "draft",
			draftAction: "edit",
			draftDocument: "document:notes@1",
		}),
		action({
			actionId: "settings-apply",
			eventAction: "settings-apply",
			effect: "write",
			operationId: "notes.apply",
			draftDocument: "document:notes@1",
			inputSchemaRef: "builtin:answerText",
			confidentialFields: ["text"],
		}),
	],
	launcher: { label: id, group: "g", order: revision },
	fields: [
		{
			fieldId: `${id}.theme`,
			document: "document:notes@1",
			path: "$.general.theme",
			label: "テーマ",
			control: "select",
			options: [{ value: "light", label: "明るい" }],
		},
		{
			fieldId: `${id}.voice`,
			document: "document:notes@1",
			path: "$.items[id=$target].voice",
			target: "notes-items",
			label: "声",
			control: "select",
			optionsSource: "query:notes.choices@1",
			visibleWhen: "condition:notes-voice@1",
		},
	],
	...over,
});
export const bundle = (
	artifacts: unknown[],
	bundleId = "notes",
	schemas: unknown[] = [],
) => ({
	formatVersion: 1,
	bundleId,
	definitions: [],
	artifacts,
	schemas,
});

export async function fixture(
	run: (ctx: {
		store: ReturnType<typeof openStore>;
		caps: ReturnType<typeof createCapabilities>;
		load: (
			raw: unknown,
			dryRun?: boolean,
		) => Promise<{
			issues: BundleIssue[];
			registered: string[];
		}>;
		published: () => string[];
	}) => Promise<void>,
) {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-standalone-"));
	const store = openStore(join(dir, "db"), migrations);
	const caps = createCapabilities(store, new Set(), { bundleHost: host });
	try {
		await run({
			store,
			caps,
			load: (raw, dryRun = false) =>
				store.write((db) =>
					caps.importBundleInTransaction(db, raw, host(), { dryRun }),
				),
			published: () =>
				store.read((db) =>
					caps.artifactsInTransaction(db).map((a) => a.artifactRevisionId),
				),
		});
	} finally {
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	}
}
export const lines = (r: { issues: BundleIssue[] }) =>
	r.issues.map((i) => `${i.code}:${i.path}`);
