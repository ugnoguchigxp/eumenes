import { z } from "zod";
import { pipelineDefinitionV1 } from "./pipelines";

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
const hostRefPattern =
	/^(adapter|availability|input|projection|connection|query|document|condition|structure|workspace):[a-z][a-z0-9._-]{0,80}(@[1-9][0-9]*)?$/;
const hostRef = (kind: string) =>
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
const schemaRef = z.string().regex(schemaRefPattern);
/** A registered operation name of an adapter (not the receipt's UUID operationId). */
const operationName = z.string().regex(/^[a-z][a-z0-9.-]{0,80}$/);
const revisionIdPattern =
	/^(package|profile|skill|tool|toolchain|requirement):[a-z][a-z0-9._-]{0,100}@[1-9][0-9]*$/;
export const bindingRevisionIdPattern =
	/^binding:[a-z][a-z0-9._-]{0,100}@[1-9][0-9]*$/;
export const artifactRevisionIdPattern =
	/^artifact:[a-z][a-z0-9._-]{0,100}@[1-9][0-9]*$/;

/** One tool of the frozen package mapped to one adapter operation. */
const bindingTool = z.strictObject({
	toolRevisionId: z
		.string()
		.regex(/^tool:[a-z][a-z0-9._-]{0,100}@[1-9][0-9]*$/),
	/** Spec name `operationId`; code calls it operationName to avoid the receipt UUID. */
	operationId: operationName,
	inputSchemaRef: schemaRef,
});

/** A question schema a command binding allows (see `commandBindingV1.questions`). */
const bindingQuestion = z.strictObject({
	inputSchemaRef: schemaRef,
	choiceField: z
		.string()
		.regex(/^[A-Za-z][A-Za-z0-9_]{0,40}$/)
		.optional(),
});

/** A tool id the agent's per-tool settings name: a binding tool's id or a host tool (`doc.edit`). */
const agentToolId = z.string().regex(/^[a-z][a-z0-9._-]{0,63}$/);
/**
 * Model calls and retries of one agent run (spec subagent-task-and-session-agents §6.4, §10): a session turn,
 * or the single-shot task a command starts after it accepted the request. `retries` is per tool, `default`
 * for the rest.
 */
const agentTurnV1 = z.strictObject({
	maxModelCalls: z.number().int().min(1).max(12).optional(),
	retries: z
		.record(
			z.union([agentToolId, z.literal("default")]),
			z.number().int().min(0).max(3),
		)
		.optional(),
});

/**
 * What a command binding sets for the single-shot task it starts after acceptance (spec
 * playwright-toolchain 2026-10-18 §5.4). It never applies to the command's own acceptance inference.
 */
const commandAgentV1 = z.strictObject({ turn: agentTurnV1 });

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
	/** Execution policy of the single-shot task started after acceptance; omitted: no task, as before. */
	agent: commandAgentV1.optional(),
});

const limitMs = z.number().int().min(10_000).max(3_600_000);
/**
 * How long work of this toolchain may take (spec toolchain-time-limits-design 2026-10-18 §3.1):
 * the run from the hand-over, one specialist turn, one inference attempt. Omitted: the host defaults.
 */
const timeLimitsV1 = z
	.strictObject({ runMs: limitMs, turnMs: limitMs, inferenceMs: limitMs })
	.refine(
		(t) => t.inferenceMs <= t.turnMs && t.turnMs <= t.runMs,
		"inferenceMs <= turnMs <= runMs",
	);

/**
 * How the session's agent works (spec subagent-task-and-session-agents 2026-10-18 §10). `workspace` names
 * the work document the adapter declares (`describe().workspaces`): the host then offers its document tools.
 * `turn` bounds one turn's model calls and the retries after a refusal per tool (`default` for the rest);
 * `memory` bounds the earlier turns kept in full. Every field is optional: the host defaults apply.
 */
const agentV1 = z.strictObject({
	workspace: z
		.strictObject({
			documentRef: hostRef("workspace"),
			/** The current document goes into the turn's input whole up to this size; above it, an outline. */
			inlineBytes: z.number().int().min(1024).max(98_304).optional(),
		})
		.optional(),
	turn: agentTurnV1.optional(),
	memory: z
		.strictObject({
			recentTurns: z.number().int().min(1).max(50).optional(),
			recentBytes: z.number().int().min(4096).max(393_216).optional(),
		})
		.optional(),
	/**
	 * One-shot toolchains the agent may call as tools without leaving the session (spec §9.3). `as` is the
	 * tool id the agent uses; `async` starts it in the background and answers when it completes (§9.4).
	 */
	sharedTools: z
		.array(
			z.strictObject({
				toolchainId: slug,
				as: z.string().regex(/^[a-z][a-z0-9_]{0,40}$/),
				async: z.boolean().optional(),
			}),
		)
		.max(8)
		.optional(),
});
export type AgentV1 = z.infer<typeof agentV1>;

/**
 * A specialist-session toolchain (spec toolchain-specialist-dialogue 2026-10-17 §4.1): after the
 * conversation hands over, the user talks to the package's specialist directly over several turns.
 * `tools` are the operations the specialist model may call (always with a host-fixed work, never a
 * client one). Undo/redo/save and other screen-only operations are artifact actions, not tools.
 */
const sessionBindingV1 = z.strictObject({
	kind: z.literal("binding"),
	id: slug,
	revision: revisionNumber,
	execution: z.literal("session"),
	adapterRef: hostRef("adapter"),
	availabilityRef: hostRef("availability"),
	tools: z.array(bindingTool).max(16),
	artifactRevisionId: z.string().regex(artifactRevisionIdPattern),
	session: z.strictObject({
		/**
		 * The schema whose `choicesInTransaction` lists the saved items a session may start from
		 * (host-issued refs offered to the conversation model). Omitted: sessions start empty only.
		 */
		targetSchemaRef: schemaRef.optional(),
	}),
	timeLimits: timeLimitsV1.optional(),
	agent: agentV1.optional(),
});
/**
 * An instant-answer toolchain: the first round of the conversation calls its function with the
 * arguments the one tool's schema declares, and the adapter's answer sentence is the answer. No
 * sub-agent, no second round, no artifact. When the adapter cannot answer, the request goes to
 * `fallbackToolchainId` in the same run.
 */
const instantBindingV1 = z.strictObject({
	kind: z.literal("binding"),
	id: slug,
	revision: revisionNumber,
	execution: z.literal("instant"),
	adapterRef: hostRef("adapter"),
	availabilityRef: hostRef("availability"),
	tools: z.array(bindingTool).length(1),
	fallbackToolchainId: slug,
});
/** Any binding kind; unknown `execution` values are rejected. */
export const taskBindingV1 = z.strictObject({
	kind: z.literal("binding"),
	id: slug,
	revision: revisionNumber,
	execution: z.literal("task"),
	adapterRef: hostRef("adapter"),
	availabilityRef: hostRef("availability"),
	tools: z.array(bindingTool).max(0),
	inputSchemaRef: schemaRef,
	outputSchemaRef: schemaRef,
	timeLimits: timeLimitsV1,
	limits: z.strictObject({
		parentCalls: z.number().int().min(2).max(12),
		childCalls: z.number().int().min(1).max(6),
		searches: z.number().int().min(1).max(3),
		modelCalls: z.number().int().min(2).max(48),
	}),
});
/**
 * A task pipeline (spec task-pipeline-design 2026-10-22 §13.1): the procedure itself is the binding's, so the
 * pipeline's revision is the binding's. No tools and no screen; `timeLimits.runMs` bounds the whole run.
 */
export const pipelineBindingV1 = z.strictObject({
	kind: z.literal("binding"),
	id: slug,
	revision: revisionNumber,
	execution: z.literal("pipeline"),
	adapterRef: hostRef("adapter"),
	availabilityRef: hostRef("availability"),
	tools: z.array(bindingTool).max(0),
	timeLimits: timeLimitsV1,
	pipeline: pipelineDefinitionV1,
});
export const bindingV1 = z.discriminatedUnion("execution", [
	commandBindingV1,
	sessionBindingV1,
	instantBindingV1,
	taskBindingV1,
	pipelineBindingV1,
]);
export type BindingV1 = z.infer<typeof bindingV1>;
/** Where one OpenUI source's data comes from: a registered adapter query. */
const sourceBindingV1 = z.strictObject({
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

/** One UI event of a source connected to an operation or a question answer. */
const actionBindingV1 = z.strictObject({
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
const documentFieldV1 = z.strictObject({
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
	/** Render non-confidential text as a multiline input; its value contract is unchanged. */
	multiline: z.boolean().optional(),
	/** A visual treatment for registered select choices; values and validation are unchanged. */
	presentation: z.enum(["segmented", "cards"]).optional(),
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
const formFieldV1 = z.strictObject({
	fieldId: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,40}$/),
	label: z.string().min(1).max(80),
	help: z.string().max(300).optional(),
	control: z.enum([
		"text",
		"textarea",
		"select",
		"toggle",
		"number",
		"secret",
		"upload",
	]),
	/** A select option is stored as text by HTML; convert declared numeric values before dispatch. */
	valueType: z.literal("number").optional(),
	/** Show this field only for rows with one of these registered values. */
	when: z
		.strictObject({
			key: z.string().regex(/^[A-Za-z][A-Za-z0-9_.]{0,80}$/),
			in: z
				.array(z.union([z.string(), z.boolean(), z.number()]))
				.min(1)
				.max(16),
		})
		.optional(),
	/** Browser file picker hint; the adapter validates the uploaded bytes. */
	accept: z.string().max(120).optional(),
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
const collectionV1 = z.strictObject({
	source: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
	title: z.string().max(80).optional(),
	/** A short note shown above the list (e.g. that registering sends data to a cloud API). */
	description: z.string().max(400).optional(),
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
				/**
				 * media: the row value is `{ path, mime }` from the adapter, a same-origin `/api/` path
				 * the host fetches with the session's authorization and previews (image/audio).
				 */
				format: z
					.enum(["text", "date", "number", "boolean", "badge", "media"])
					.default("text"),
			}),
		)
		.min(1)
		.max(16),
	rowActions: z
		.array(
			z.strictObject({
				actionId: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
				/** Asked before the action is sent (e.g. deletes). */
				confirm: z.string().max(200).optional(),
				/**
				 * Disabled while the shared draft of this document has unapplied changes (e.g. a
				 * connection probe that tests the saved settings, not the draft).
				 */
				requiresCleanDraft: hostRef("document").optional(),
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
			/** Map a displayed column to a non-confidential form field for unsaved rows. */
			preview: z
				.record(
					z.string().regex(/^[A-Za-z][A-Za-z0-9_.]{0,80}$/),
					z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.-]{0,80}$/),
				)
				.optional(),
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
const artifactVariantV1 = z.strictObject({
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
				icon: z
					.enum([
						"conversation",
						"voice",
						"display",
						"connections",
						"external",
						"memory",
						"dictionary",
						"checks",
						"records",
						"world",
					])
					.optional(),
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
		/** Shared drafts read by actions on this screen, without editing the document here. */
		draftDependencies: z.array(hostRef("document")).max(8).optional(),
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

/** An existing revision the bundle depends on, fixed by its stored digest. */
const bundlePin = z.strictObject({
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
	bindings: z.array(bindingV1).max(32).default([]),
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
			/** The adapter answers instant bindings (see `DomainAdapter.instant`). */
			instant?: boolean;
			task?: boolean;
			/** The adapter runs task pipelines (binding execution "pipeline"). */
			pipeline?: boolean;
			/** Work documents its session offers (`workspace:` refs, see `DomainAdapter.workspaces`). */
			workspaces?: ReadonlySet<string>;
		}
	>;
	availability: ReadonlySet<string>;
	inputAdapters: ReadonlySet<string>;
	projections: ReadonlySet<string>;
	/** `domain:` refs the host registered (builtin and bundle refs are checked by capabilities). */
	domainSchemas: ReadonlySet<string>;
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
