import { z } from "zod";

/**
 * Versioned bindings and artifact registrations (spec: timer-data-driven-ui-acceptance-design
 * 2026-10-13 §5). A binding connects a toolchain's frozen package tools to a host-registered
 * adapter's operations; an artifact registration connects an OpenUI definition to its sources
 * and actions. Both are stored as their own immutable revisions next to capability revisions and
 * referenced only from new toolchain revisions, so earlier revision JSON and hashes never change.
 */

const revisionNumber = z.number().int().min(1).max(1_000_000);
const slug = z.string().regex(/^[a-z][a-z0-9._-]{0,100}$/);
/** `adapter:timers@1`, `availability:timers@1`, `input:timer-hms@1`, `projection:timer-result@1`. */
export const hostRefPattern =
	/^(adapter|availability|input|projection|connection|query|document|condition|structure):[a-z][a-z0-9._-]{0,80}(@[1-9][0-9]*)?$/;
export const hostRef = (kind: string) =>
	z
		.string()
		.regex(hostRefPattern)
		.refine((v) => v.startsWith(`${kind}:`), `${kind} ref`);
/**
 * Schema references. `builtin:<SchemaKey>` is a Zod validator of this repository,
 * `domain:<owner>.<name>@n` a domain result schema registered by the host, and
 * `schema:<id>@n` a JSON Schema (finite subset) shipped inside a bundle.
 */
export const schemaRefPattern =
	/^(builtin:[A-Za-z][A-Za-z0-9]{0,60}|domain:[a-z][a-z0-9.-]{0,80}@[1-9][0-9]*|schema:[a-z][a-z0-9.-]{0,80}@[1-9][0-9]*)$/;
export const schemaRef = z.string().regex(schemaRefPattern);
/** A registered operation name of an adapter (not the receipt's UUID operationId). */
export const operationName = z.string().regex(/^[a-z][a-z0-9.-]{0,80}$/);
export const revisionIdPattern =
	/^(package|profile|skill|tool|toolchain|requirement):[a-z][a-z0-9._-]{0,100}@[1-9][0-9]*$/;
export const bindingRevisionIdPattern =
	/^binding:[a-z][a-z0-9._-]{0,100}@[1-9][0-9]*$/;
export const artifactRevisionIdPattern =
	/^artifact:[a-z][a-z0-9._-]{0,100}@[1-9][0-9]*$/;
export const schemaRevisionIdPattern =
	/^schema:[a-z][a-z0-9.-]{0,80}@[1-9][0-9]*$/;

/** One tool of the frozen package mapped to one adapter operation. */
export const bindingTool = z.strictObject({
	toolRevisionId: z
		.string()
		.regex(/^tool:[a-z][a-z0-9._-]{0,100}@[1-9][0-9]*$/),
	/** Spec name `operationId`; code calls it operationName to avoid the receipt UUID. */
	operationId: operationName,
	inputSchemaRef: schemaRef,
});

/** A question schema a command binding allows (see `commandBindingV1.questions`). */
export const bindingQuestion = z.strictObject({
	inputSchemaRef: schemaRef,
	choiceField: z
		.string()
		.regex(/^[A-Za-z][A-Za-z0-9_]{0,40}$/)
		.optional(),
});
export type BindingQuestion = z.infer<typeof bindingQuestion>;

/** A command toolchain executed by a typed host adapter. */
export const commandBindingV1 = z.strictObject({
	kind: z.literal("binding"),
	id: slug,
	revision: revisionNumber,
	execution: z.literal("command"),
	adapterRef: hostRef("adapter"),
	availabilityRef: hostRef("availability"),
	tools: z.array(bindingTool).min(1).max(32),
	outputSchemaRef: schemaRef,
	resultProjectionRef: hostRef("projection"),
	artifactRevisionId: z.string().regex(artifactRevisionIdPattern),
	/**
	 * The question schemas the command sub-agent may ask with, besides the generic free-text
	 * `builtin:answerText`. `choiceField` names the schema field the host fills from its own
	 * choices (the adapter's `choicesInTransaction`); the model never offers choices itself.
	 */
	questions: z.array(bindingQuestion).max(8).optional(),
});
export type CommandBindingV1 = z.infer<typeof commandBindingV1>;

const fieldMap = z.record(
	z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,40}$/),
	z.union([
		z.strictObject({ literal: z.union([z.string(), z.number(), z.boolean()]) }),
		z.strictObject({
			inputField: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,40}$/),
		}),
	]),
);
/**
 * A simple declarative HTTP JSON API (§5.3). Finite field mapping only: literals and fields of
 * the validated input. The connection (base URL, credentials) is resolved by the backend from a
 * registered connection; the model and the browser never choose the destination.
 */
export const httpJsonBindingV1 = z.strictObject({
	kind: z.literal("http-binding"),
	id: slug,
	revision: revisionNumber,
	transport: z.literal("http-json"),
	connectionRef: hostRef("connection"),
	method: z.enum(["GET", "POST"]),
	pathTemplate: z
		.string()
		.regex(/^\/[A-Za-z0-9._~\-/{}]{0,200}$/)
		.refine((p) => !p.includes(".."), "path"),
	pathFields: fieldMap.default({}),
	queryFields: fieldMap.default({}),
	bodyFields: fieldMap.default({}),
	inputSchemaRef: schemaRef,
	outputSchemaRef: schemaRef,
	permission: z.enum(["read", "write"]),
	timeoutMs: z.number().int().min(100).max(30_000),
	maxResponseBytes: z.number().int().min(1).max(1_048_576),
	retry: z.union([
		z.strictObject({ mode: z.literal("none") }),
		/** POST may be resent only with a registered idempotency key header and lookup. */
		z.strictObject({
			mode: z.literal("idempotency-key"),
			header: z.string().regex(/^[A-Za-z][A-Za-z0-9-]{0,60}$/),
			maxAttempts: z.number().int().min(1).max(3),
		}),
	]),
});
export type HttpJsonBindingV1 = z.infer<typeof httpJsonBindingV1>;

/** Where one OpenUI source's data comes from: a registered adapter query. */
export const sourceBindingV1 = z.strictObject({
	/** The `source` name used inside the OpenUI definition. */
	source: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
	adapterRef: hostRef("adapter"),
	/** Registered read query of the adapter, e.g. `query:timers.current@1`. */
	query: hostRef("query"),
	/** none: no target; required: the host resolves one target ref it issued (e.g. a timer id). */
	target: z.enum(["none", "required", "optional"]),
	/**
	 * Read parameters the client may pass to this source (paging, sorting, search), validated by
	 * this schema. Reads never go through the action ledger.
	 */
	paramsSchemaRef: schemaRef.optional(),
});
export type SourceBindingV1 = z.infer<typeof sourceBindingV1>;

/** One UI event of a source connected to an operation or a question answer. */
export const actionBindingV1 = z.strictObject({
	actionId: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
	/** The existing ArtifactEvent action this binding accepts (compatibility layer). */
	eventAction: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
	source: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
	/** Exactly one of operationId (adapter operation) or answer (open interaction question). */
	operationId: operationName.optional(),
	answer: z.literal(true).optional(),
	inputSchemaRef: schemaRef,
	/** Registered typed input conversion, e.g. `input:timer-hms@1`. */
	inputAdapterRef: hostRef("input").optional(),
	/**
	 * write: an adapter operation through the action ledger (reads are parameterized source
	 * reads, never ledger entries). local: handled by the Web
	 * adapter (clock mode, stopwatch). navigate: the common host opens `navigateTo`. draft: the
	 * common host edits or discards the shared draft of `draftDocument` (`draftAction`).
	 */
	effect: z.enum(["write", "local", "navigate", "draft"]),
	/**
	 * navigate only: the registered artifact to open — fixed (`artifactId`), or chosen by the
	 * event's string value `byValue` from a closed map of value → artifact id.
	 */
	navigateTo: z
		.union([
			z.strictObject({ artifactId: slug }),
			z.strictObject({
				byValue: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,40}$/),
				artifacts: z
					.record(z.string().regex(/^[a-z][a-z0-9-]{0,40}$/), slug)
					.refine(
						(m) => Object.keys(m).length >= 1 && Object.keys(m).length <= 32,
					),
			}),
		])
		.optional(),
	/** draft only. */
	draftAction: z.enum(["edit", "discard", "structure"]).optional(),
	/** draftAction "structure": the adapter's registered structural operation staged in the draft. */
	structure: hostRef("structure").optional(),
	/** Shown in change reviews and as the button text of collection actions. */
	label: z.string().min(1).max(80).optional(),
	/**
	 * Collection row actions: the operation input built from the row by fixed paths
	 * (`$row.revision`) or string literals; the client never sends row values by itself.
	 */
	rowInput: z
		.record(
			z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,40}$/),
			z.union([
				z.string().regex(/^\$row(\.[A-Za-z][A-Za-z0-9_]{0,40})+$/),
				z.strictObject({
					literal: z.union([z.string(), z.number(), z.boolean()]),
				}),
				/**
				 * A new UUID the host generates once per staged/sent action (e.g. the id of a
				 * connection added in a draft, so later field changes can target it).
				 */
				z.strictObject({ generate: z.literal("uuid") }),
			]),
		)
		.optional(),
	/**
	 * The adapter document whose shared draft this action edits (draft) or applies (write: the
	 * host sends the frozen draft changes as the operation input).
	 */
	draftDocument: hostRef("document").optional(),
	/**
	 * Input paths (top-level keys) holding secrets: never stored in the outbox, the action ledger
	 * body, logs or snapshots; the ledger keeps an HMAC only.
	 */
	confidentialFields: z
		.array(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,40}$/))
		.max(8)
		.optional(),
});
export type ActionBindingV1 = z.infer<typeof actionBindingV1>;

/**
 * A registered field of an adapter-owned document (e.g. the settings document). The path is a
 * fixed, reviewed pointer checked by the adapter against its own schema; clients never send paths.
 * `$.a.b` or an array element chosen by stable id: `$.resources[id=$target].voice`.
 */
export const documentFieldV1 = z.strictObject({
	fieldId: z.string().regex(/^[a-z][a-z0-9.-]{0,80}$/),
	document: hostRef("document"),
	path: z
		.string()
		.regex(
			/^\$(\.[A-Za-z][A-Za-z0-9_]{0,40}(\[id=\$target\])?)+$/,
			"fixed path",
		),
	/** The source listing the array targets, when the path selects `[id=$target]`. */
	target: z
		.string()
		.regex(/^[a-z][a-z0-9-]{0,63}$/)
		.optional(),
	label: z.string().min(1).max(80),
	help: z.string().max(300).optional(),
	group: z
		.string()
		.regex(/^[a-z][a-z0-9-]{0,40}$/)
		.optional(),
	/** Shown under the detail disclosure. */
	detail: z.boolean().optional(),
	control: z.enum(["text", "select", "toggle", "range", "number", "multiple"]),
	options: z
		.array(
			z.strictObject({
				value: z.string().max(200),
				label: z.string().min(1).max(120),
			}),
		)
		.max(64)
		.optional(),
	/** A registered adapter query returning the options at runtime. */
	optionsSource: hostRef("query").optional(),
	searchable: z.boolean().optional(),
	min: z.number().optional(),
	max: z.number().optional(),
	step: z.number().positive().optional(),
	maxLength: z.number().int().positive().max(4096).optional(),
	/** What an empty input means; only for optional fields. */
	unset: z.enum(["delete-key", "null", "empty-string"]).optional(),
	/** The value shown when the document has none (display only; never written as a change). */
	defaultValue: z.string().max(200).optional(),
	/** A secret: kept only in the draft's memory and sent through confidential action fields. */
	confidential: z.boolean().optional(),
	/** A registered condition (evaluated by the Web adapter) that shows the field. */
	visibleWhen: hostRef("condition").optional(),
});
export type DocumentFieldV1 = z.infer<typeof documentFieldV1>;

/** A field of a collection's create/edit form; its values become the action input. */
export const formFieldV1 = z.strictObject({
	fieldId: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,40}$/),
	label: z.string().min(1).max(80),
	help: z.string().max(300).optional(),
	control: z.enum(["text", "textarea", "select", "toggle", "number", "secret"]),
	options: z
		.array(
			z.strictObject({
				value: z.string().max(200),
				label: z.string().min(1).max(120),
			}),
		)
		.max(64)
		.optional(),
	optionsSource: hostRef("query").optional(),
	maxLength: z.number().int().positive().max(8192).optional(),
	min: z.number().optional(),
	max: z.number().optional(),
	required: z.boolean().optional(),
	/** A secret: never echoed, stored in the outbox or logged; the action must list it in confidentialFields. */
	confidential: z.boolean().optional(),
	/** The initial form value (toggle "true"/"false", numbers as decimal text); never for secrets. */
	defaultValue: z.string().max(200).optional(),
});
export type FormFieldV1 = z.infer<typeof formFieldV1>;

/** A registered list editor: rows from an adapter query, columns, row actions and a create form. */
export const collectionV1 = z.strictObject({
	source: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
	title: z.string().max(80).optional(),
	/** The row field holding its stable id. */
	rowKey: z.string().regex(/^[A-Za-z][A-Za-z0-9_.]{0,80}$/),
	/** Where the rows are inside the source data (default: the data itself is the array). */
	rowsPath: z
		.string()
		.regex(/^[A-Za-z][A-Za-z0-9_.]{0,80}$/)
		.optional(),
	columns: z
		.array(
			z.strictObject({
				key: z.string().regex(/^[A-Za-z][A-Za-z0-9_.]{0,80}$/),
				label: z.string().min(1).max(60),
				format: z
					.enum(["text", "date", "number", "boolean", "badge"])
					.default("text"),
			}),
		)
		.min(1)
		.max(12),
	rowActions: z
		.array(
			z.strictObject({
				actionId: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
				/** Asked before the action is sent (e.g. deletes). */
				confirm: z.string().max(200).optional(),
				/**
				 * Opens a form for the row before sending (row edit). Its values join the input built
				 * by the action's rowInput; `prefill` fills the form from the row by fixed paths.
				 */
				form: z
					.strictObject({
						fields: z.array(formFieldV1).min(1).max(24),
						prefill: z
							.record(
								z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,40}$/),
								z.string().regex(/^\$row(\.[A-Za-z][A-Za-z0-9_]{0,40})+$/),
							)
							.default({}),
					})
					.optional(),
				/** Shown only when the row field equals one of the values (finite, no expressions). */
				when: z
					.strictObject({
						key: z.string().regex(/^[A-Za-z][A-Za-z0-9_.]{0,80}$/),
						in: z
							.array(z.union([z.string(), z.boolean(), z.number()]))
							.min(1)
							.max(16),
					})
					.optional(),
			}),
		)
		.max(8)
		.default([]),
	create: z
		.strictObject({
			actionId: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
			fields: z.array(formFieldV1).min(1).max(24),
		})
		.optional(),
	/** The source accepts paging/search params (its binding has paramsSchemaRef). */
	paging: z.boolean().optional(),
	/**
	 * Re-read the source every few seconds only while some row's field is in these values (e.g.
	 * a running test); no other polling exists.
	 */
	refreshWhile: z
		.strictObject({
			key: z.string().regex(/^[A-Za-z][A-Za-z0-9_.]{0,80}$/),
			in: z
				.array(z.union([z.string(), z.boolean(), z.number()]))
				.min(1)
				.max(16),
		})
		.optional(),
});
export type CollectionV1 = z.infer<typeof collectionV1>;

/** A presentation of the same sources and actions; variants differ only in layout. */
export const artifactVariantV1 = z.strictObject({
	id: z.string().regex(/^[a-z][a-z0-9-]{0,40}$/),
	label: z.string().min(1).max(80),
	/** OpenUI JSON definition text, checked by the registered artifact-ui parser on the Web. */
	definition: z.unknown(),
	/** The same definition with a question leaf, used while a question is open. */
	questionDefinition: z.unknown().optional(),
});

export const artifactDefinitionV1 = z
	.strictObject({
		kind: z.literal("artifact"),
		id: slug,
		revision: revisionNumber,
		/** Launcher and tab title. One entry per artifact, never one per saved item. */
		title: z.string().min(1).max(80),
		variants: z.array(artifactVariantV1).min(1).max(8),
		defaultVariant: z.string(),
		sourceBindings: z.array(sourceBindingV1).min(1).max(16),
		actionBindings: z.array(actionBindingV1).max(48),
		/**
		 * Published on its own (no toolchain): a launcher entry. A newer revision of the same id
		 * switches the published pointer, as with toolchains.
		 */
		launcher: z
			.strictObject({
				label: z.string().min(1).max(80),
				/** Shown with the entry inside a hub screen. */
				description: z.string().max(200).optional(),
				/**
				 * Without a group the entry is in the top launcher menu; with a group it is published
				 * for in-app navigation (e.g. a hub screen) and grouped there, not in the top menu.
				 */
				group: z.string().max(40).optional(),
				order: z.number().int().min(0).max(1000).optional(),
			})
			.optional(),
		/** Registered fields of adapter documents shown by this artifact. */
		fields: z.array(documentFieldV1).max(128).optional(),
		/** Registered list editors over adapter queries (see collectionV1). */
		collections: z.array(collectionV1).max(8).optional(),
	})
	.superRefine((a, ctx) => {
		if (!a.variants.some((v) => v.id === a.defaultVariant))
			ctx.addIssue({ code: "custom", message: "defaultVariant" });
		const sources = new Set(a.sourceBindings.map((s) => s.source));
		if (sources.size !== a.sourceBindings.length)
			ctx.addIssue({ code: "custom", message: "duplicate source" });
		const ids = new Set<string>();
		for (const action of a.actionBindings) {
			if (!sources.has(action.source))
				ctx.addIssue({ code: "custom", message: "unknown action source" });
			if (ids.has(action.actionId))
				ctx.addIssue({ code: "custom", message: "duplicate action" });
			ids.add(action.actionId);
			const sent = action.effect === "write";
			if (sent && !!action.operationId === !!action.answer)
				ctx.addIssue({ code: "custom", message: "operation or answer" });
			if ((action.effect === "navigate") !== !!action.navigateTo)
				ctx.addIssue({ code: "custom", message: "navigateTo" });
			if ((action.effect === "draft") !== !!action.draftAction)
				ctx.addIssue({ code: "custom", message: "draftAction" });
			if (action.effect === "draft" && !action.draftDocument)
				ctx.addIssue({ code: "custom", message: "draftDocument" });
			if ((action.draftAction === "structure") !== !!action.structure)
				ctx.addIssue({ code: "custom", message: "structure" });
		}
	});
export type ArtifactDefinitionV1 = z.infer<typeof artifactDefinitionV1>;

/** A JSON Schema of the finite subset (§5.1) shipped inside a bundle. */
export const bundleSchemaV1 = z.strictObject({
	kind: z.literal("schema"),
	id: z.string().regex(/^[a-z][a-z0-9.-]{0,80}$/),
	revision: revisionNumber,
	schema: z.record(z.string(), z.unknown()),
});
export type BundleSchemaV1 = z.infer<typeof bundleSchemaV1>;

/** An existing revision the bundle depends on, fixed by its stored digest. */
export const bundlePin = z.strictObject({
	revisionId: z.string().regex(revisionIdPattern),
	digest: z.string().regex(/^[0-9a-f]{64}$/),
});

/**
 * The distributable unit: definitions (capability Definition JSON, profile/SKILL bodies as UTF-8
 * text inside them), bindings, artifact registrations and schemas. Never code: no shell,
 * JavaScript, module or URL is executed from it.
 */
export const capabilityBundleV1 = z.strictObject({
	formatVersion: z.literal(1),
	bundleId: slug,
	pins: z.array(bundlePin).max(64).default([]),
	definitions: z.array(z.record(z.string(), z.unknown())).max(64),
	bindings: z
		.array(z.union([commandBindingV1, httpJsonBindingV1]))
		.max(32)
		.default([]),
	artifacts: z.array(artifactDefinitionV1).max(16).default([]),
	schemas: z.array(bundleSchemaV1).max(32).default([]),
});
export type CapabilityBundleV1 = z.infer<typeof capabilityBundleV1>;

/** What a document's schema says about one fixed path; null when the path names no field. */
export type DocumentPathInfo = {
	kind: "string" | "number" | "integer" | "boolean" | "enum" | "array";
	/** Allowed values of an enum, or of the items of an array of enums. */
	values?: readonly string[];
	min?: number;
	max?: number;
	maxLength?: number;
	/** May be absent (`delete-key`) or null (`null`). */
	optional: boolean;
	nullable: boolean;
};
export type DocumentDescription = {
	describePath(path: string): DocumentPathInfo | null;
	/**
	 * For `[id=$target]` paths: the registered query whose data lists the allowed targets
	 * (registration requires the field's target source to use it).
	 */
	targetQuery?(path: string): string | null;
};

/** What this host can execute; bundles referring to anything else are rejected before saving. */
export type BundleHost = {
	adapters: ReadonlyMap<
		string,
		{
			operations: ReadonlyMap<string, { inputSchemaRef: string }>;
			queries: ReadonlySet<string>;
			/** Documents whose fields may be registered, with the adapter's own path description. */
			documents?: ReadonlyMap<string, DocumentDescription>;
			/** Field visibility conditions the adapter's Web counterpart implements. */
			conditions?: ReadonlySet<string>;
			/** Structural draft operations (`structure:` refs) and their input schemas. */
			structures?: ReadonlyMap<string, { inputSchemaRef: string }>;
		}
	>;
	availability: ReadonlySet<string>;
	inputAdapters: ReadonlySet<string>;
	projections: ReadonlySet<string>;
	/** `domain:` refs the host registered (builtin and bundle refs are checked by capabilities). */
	domainSchemas: ReadonlySet<string>;
	connections: ReadonlySet<string>;
};

/** One reason a bundle cannot be registered; the dry-run lists all of them. */
export type BundleIssue = {
	code:
		| "invalid_format"
		| "unknown_reference"
		| "digest_mismatch"
		| "revision_conflict"
		| "dependency_cycle"
		| "unregistered_adapter"
		| "unregistered_operation"
		| "unregistered_query"
		| "unregistered_input_adapter"
		| "unregistered_projection"
		| "unavailable"
		| "duplicate_function"
		| "unsupported_schema"
		| "schema_mismatch"
		| "invalid_toolchain"
		| "permission";
	path: string;
	ref?: string;
};

/** A stored binding/artifact/schema revision. */
export type FixedDocument<T> = {
	revisionId: string;
	digest: string;
	document: T;
};
