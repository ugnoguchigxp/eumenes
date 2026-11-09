import type { Database } from "bun:sqlite";
import { z } from "zod";
import {
	prepareWorkflowSchema,
	type Capabilities,
} from "../../domains/capabilities";
import {
	checkWorkflowDefinition,
	saveWorkflowInTransaction,
	workflowComponentsDigest,
	workflowDraftDigest,
	workflowSaveReceiptInTransaction,
	type WorkflowCatalog,
} from "../../domains/pipelines";
import {
	prepareWorkflowScreen,
	saveWorkflowScreenInTransaction,
	workflowScreenInTransaction,
} from "../../domains/ui-compositions";
import type { SqliteStore } from "../../infrastructure/sqlite";
import { canonicalJson, sha256Hex } from "../../infrastructure/digest";

const draftInput = z.strictObject({
	definition: z.json(),
	schemas: z
		.array(
			z.strictObject({
				name: z.string(),
				schema: z.record(z.string(), z.json()),
			}),
		)
		.max(32),
	screen: z
		.strictObject({ definition: z.json(), bindings: z.json() })
		.optional(),
});

export type WorkflowAuthoringSource = {
	scope: string;
	workflowId: string;
	conversationId: string;
	sourceRequest: string;
	expectedRevision: number;
	screenId?: string;
	grantDigest?: string;
};
type CheckedDefinition = ReturnType<
	typeof checkWorkflowDefinition
>["definition"];

const authoringDigest = (
	source: WorkflowAuthoringSource,
	input: z.infer<typeof draftInput>,
) =>
	sha256Hex(
		canonicalJson([source, input], {
			omitUndefined: true,
			keyOrder: "codeUnit",
		}),
	);

export function createWorkflowAuthoring(deps: {
	store: SqliteStore;
	capabilities: Pick<
		Capabilities,
		"registerWorkflowSchemaInTransaction" | "workflowSchemaInTransaction"
	>;
	catalog(db: Database, source: WorkflowAuthoringSource): WorkflowCatalog;
	mayConfirm(
		db: Database,
		source: WorkflowAuthoringSource,
		definition: CheckedDefinition,
	): boolean;
}) {
	function prepare(
		db: Database,
		source: WorkflowAuthoringSource,
		input: z.infer<typeof draftInput>,
	) {
		const { scope, workflowId, conversationId, sourceRequest } = source;
		const owner = { scope, workflowId };
		const revision = source.expectedRevision + 1;
		const schemaInputs = input.schemas.map((item) => ({
			...item,
			...owner,
			revision,
		}));
		const schemas = schemaInputs.map(prepareWorkflowSchema);
		const byRef = new Map(schemas.map((schema) => [schema.revisionId, schema]));
		if (byRef.size !== schemas.length)
			throw new Error("workflow_schema_duplicate");
		const generated = new Map(
			input.schemas.map(({ name }, index) => [
				`schema:generated:${name}`,
				schemas[index]!.revisionId,
			]),
		);
		const definitionInput = Object.assign({}, input.definition);
		for (const field of ["input", "publish", "checkpoint"]) {
			const value = (definitionInput as Record<string, unknown>)[field];
			if (
				!value ||
				typeof value !== "object" ||
				Array.isArray(value) ||
				!("schemaRef" in value) ||
				typeof value.schemaRef !== "string"
			)
				continue;
			const ref = generated.get(value.schemaRef);
			if (ref)
				(definitionInput as Record<string, unknown>)[field] = {
					...value,
					schemaRef: ref,
				};
		}
		const screenInput = input.screen
			? { ...input.screen, id: source.screenId ?? workflowId, revision }
			: null;
		const screen = screenInput ? prepareWorkflowScreen(screenInput) : null;
		const catalog = deps.catalog(db, source);
		const ownedSchema = (ref: string) =>
			deps.capabilities.workflowSchemaInTransaction(db, ref, owner);
		const scopedCatalog = {
			...catalog,
			schema: (ref: string) =>
				byRef.get(ref)?.validate ??
				ownedSchema(ref)?.validate ??
				catalog.schema(ref),
		};
		const { definition, pins } = checkWorkflowDefinition(
			definitionInput,
			sourceRequest,
			scopedCatalog,
		);
		if (
			definition.publish.kind === "dataset" &&
			!screen?.value.bindings.table &&
			!screen?.value.bindings.sections
		)
			throw new Error("workflow_artifact_required");
		if (screen)
			validateBindings(screen.value.bindings, definition, scopedCatalog);
		const schemaRefs = new Set([
			definition.input.schemaRef,
			...pins.map((pin) => pin.outputSchemaRef),
			...(definition.checkpoint ? [definition.checkpoint.schemaRef] : []),
			...byRef.keys(),
		]);
		const snapshots = [...schemaRefs].sort().flatMap((revisionId) => {
			const digest =
				byRef.get(revisionId)?.digest ?? ownedSchema(revisionId)?.digest;
			return digest ? [{ revisionId, digest }] : [];
		});
		const draft = {
			definition: definitionInput,
			schemas: snapshots,
			...(screen
				? { artifact: { id: screen.id, revision, digest: screen.digest } }
				: {}),
			grant: {
				conversationId,
				...(source.grantDigest ? { authorityDigest: source.grantDigest } : {}),
			},
			componentsDigest: workflowComponentsDigest(pins),
			authoringDigest: authoringDigest(source, input),
		};
		return {
			definition,
			draft,
			digest: workflowDraftDigest(draft),
			owner,
			schemaInputs,
			screenInput,
			scopedCatalog,
		};
	}
	function previewInTransaction(
		db: Database,
		source: WorkflowAuthoringSource,
		rawDraft: unknown,
	) {
		const { definition, digest } = prepare(
			db,
			source,
			draftInput.parse(rawDraft),
		);
		return { definition, digest };
	}
	function confirmInTransaction(
		db: Database,
		source: WorkflowAuthoringSource,
		rawDraft: unknown,
		operationId: string,
		confirmedDigest: string,
	) {
		const input = draftInput.parse(rawDraft);
		const previous = workflowSaveReceiptInTransaction(
			db,
			source.scope,
			operationId,
		);
		if (previous) {
			if (
				previous.digest !== confirmedDigest ||
				previous.value.authoringDigest !== authoringDigest(source, input)
			)
				throw new Error("request_conflict");
			if (!deps.mayConfirm(db, source, previous.value.definition))
				throw new Error("workflow_confirmation_forbidden");
			return previous;
		}
		const prepared = prepare(db, source, input);
		if (prepared.digest !== confirmedDigest)
			throw new Error("workflow_confirmation_changed");
		if (!deps.mayConfirm(db, source, prepared.definition))
			throw new Error("workflow_confirmation_forbidden");
		for (const schema of prepared.schemaInputs)
			deps.capabilities.registerWorkflowSchemaInTransaction(db, schema);
		if (prepared.screenInput)
			saveWorkflowScreenInTransaction(db, prepared.owner, prepared.screenInput);
		return saveWorkflowInTransaction(
			db,
			{
				...prepared.owner,
				expectedRevision: source.expectedRevision,
				operationId,
				confirmedDigest,
				draft: prepared.draft,
			},
			source.sourceRequest,
			{
				...prepared.scopedCatalog,
				schemaDigest: (ref) =>
					deps.capabilities.workflowSchemaInTransaction(db, ref, prepared.owner)
						?.digest ?? null,
				artifactDigest: (id, revision) =>
					workflowScreenInTransaction(db, prepared.owner, id, revision)
						?.digest ?? null,
			},
		);
	}
	return {
		previewInTransaction,
		confirmInTransaction,
		preview: (source: WorkflowAuthoringSource, rawDraft: unknown) =>
			deps.store.read((db) => previewInTransaction(db, source, rawDraft)),
		confirm: (
			source: WorkflowAuthoringSource,
			rawDraft: unknown,
			operationId: string,
			confirmedDigest: string,
		) =>
			deps.store.write((db) =>
				confirmInTransaction(
					db,
					source,
					rawDraft,
					operationId,
					confirmedDigest,
				),
			),
	};
}

function validateBindings(
	bindings: ReturnType<typeof prepareWorkflowScreen>["value"]["bindings"],
	definition: CheckedDefinition,
	catalog: WorkflowCatalog,
) {
	const input = catalog.schema(definition.input.schemaRef);
	const keys = Object.values(bindings.inputs);
	if (
		!(input instanceof z.ZodObject) ||
		new Set(keys).size !== keys.length ||
		keys.some(
			(key) =>
				!Object.hasOwn(input.shape, key) ||
				Object.hasOwn(definition.input.fixed, key),
		)
	)
		throw new Error("workflow_screen_input_invalid");
	const { table, sections } = bindings;
	const rowsKey = (table ?? sections)?.rowsKey;
	const fields = table?.columns ?? sections?.itemKeys;
	if (!rowsKey || !fields) return;
	const output = catalog.schema(definition.publish.schemaRef);
	const rows =
		output instanceof z.ZodObject && Object.hasOwn(output.shape, rowsKey)
			? output.shape[rowsKey]
			: null;
	const row = rows instanceof z.ZodArray ? rows.element : null;
	if (
		!(row instanceof z.ZodObject) ||
		fields.some((key) => !Object.hasOwn(row.shape, key)) ||
		(sections && !(row.shape[sections.groupBy] instanceof z.ZodString))
	)
		throw new Error(
			sections
				? "workflow_screen_sections_invalid"
				: "workflow_screen_table_invalid",
		);
}
