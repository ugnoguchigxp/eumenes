import type { Database } from "bun:sqlite";
import {
	AppStorageDefinitionError,
	appDigest,
	type AppDevelopment,
	type AppDraft,
} from "../../domains/app-development";
import {
	WorkflowPipelineError,
	workflowRevisionInTransaction,
} from "../../domains/pipelines";
import {
	fieldsOfDefinition,
	prepareWorkflowScreen,
} from "../../domains/ui-compositions";
import type {
	createWorkflowAuthoring,
	WorkflowAuthoringSource,
} from "../pipelines/workflow-authoring";
import {
	appSourceUrlAllowed,
	type AppRequestEvidenceReader,
} from "./app-request-context";
import { storageForSave } from "./storage-runtime";
import { workflowRefs } from "./workflow-operations";
type Work = ReturnType<AppDevelopment["draft"]>;

export function createAppPreview(
	service: AppDevelopment,
	authoring: () => ReturnType<typeof createWorkflowAuthoring>,
	grantDigest: (publishKind: unknown) => string,
	readEvidence: AppRequestEvidenceReader,
) {
	function draftArguments(db: Database, work: Work, draft: AppDraft) {
		if (!work.request || !work.conversationId)
			throw new Error("app_source_unavailable");
		const pipeline = draft.workflow?.pipeline;
		if (!pipeline || typeof pipeline !== "object" || Array.isArray(pipeline))
			throw new Error("workflow_pipeline_invalid");
		const sourceUrl = (
			draft.workflow?.input as { fixed?: { sourceUrl?: unknown } } | undefined
		)?.fixed?.sourceUrl;
		if (
			typeof sourceUrl === "string" &&
			!appSourceUrlAllowed(db, work, sourceUrl, readEvidence)
		)
			throw new WorkflowPipelineError([
				{
					path: "workflow.input.fixed.sourceUrl",
					rule: "workflow_source_url_unconfirmed",
					detail:
						"有効な本人の指定にURLがありません。指定がなければsourceUrlを省略してください。",
				},
			]);
		const source: WorkflowAuthoringSource = {
			scope: service.scope,
			workflowId: work.appId,
			conversationId: work.conversationId,
			sourceRequest: work.requestContext?.current ?? work.request,
			screenId: `${work.appId}.workflow`,
			grantDigest: grantDigest(
				(draft.workflow?.publish as { kind?: unknown } | undefined)?.kind,
			),
			expectedRevision:
				workflowRevisionInTransaction(db, service.scope, work.appId)
					?.revision ?? 0,
		};
		const input = {
			definition: {
				...draft.workflow,
				pipeline: {
					...pipeline,
					request: work.requestContext?.current ?? work.request,
				},
			},
			schemas: draft.schemas,
			...(draft.screen
				? {
						screen: {
							definition: draft.screen.definition,
							bindings: draft.screen.bindings ?? { inputs: {} },
						},
					}
				: {}),
		};
		return { source, input };
	}
	return function preview(db: Database, work: Work) {
		const draft = work.draft;
		if (!draft) throw new Error("app_draft_unavailable");
		const storage = storageForSave(db, service, work.appId, draft);
		checkStorageScreen(draft, storage);
		const storageSummary = storage?.collections.map(
			({ id, operations, columns }) => ({ id, operations, columns }),
		);
		if (draft.workflow) {
			const args = draftArguments(db, work, draft);
			const checked = authoring().previewInTransaction(
				db,
				args.source,
				args.input,
			);
			if (checked.definition.input.schemaRef === workflowRefs.storageInput) {
				const { collection, operation } = checked.definition.input.fixed;
				const owned = storage?.collections.find(({ id }) => id === collection);
				if (
					!owned ||
					typeof operation !== "string" ||
					!owned.operations.some((value) => value === operation)
				)
					throw new Error("app_storage_operation_forbidden");
			}
			return {
				digest: appDigest([
					work.revision,
					draft.title,
					checked.digest,
					...(storage ? [storage] : []),
				]),
				storage,
				args,
				workflowDigest: checked.digest,
				summary: { ...checked.definition, storage: storageSummary },
			};
		}
		const screen = {
			id: work.appId,
			revision: work.savedRevision + 1,
			definition: draft.screen?.definition,
			bindings: draft.screen?.bindings ?? { inputs: {} },
		};
		const checked = prepareWorkflowScreen(screen);
		if (
			Object.keys(checked.value.bindings.inputs).length ||
			checked.value.bindings.table ||
			checked.value.bindings.sections
		)
			throw new Error("app_bindings_require_workflow");
		return {
			digest: appDigest([
				work.revision,
				draft.title,
				checked.digest,
				...(storage ? [storage] : []),
			]),
			storage,
			screen,
			summary: storageSummary ? { storage: storageSummary } : null,
		};
	};
}

function checkStorageScreen(
	draft: AppDraft,
	plan: ReturnType<typeof storageForSave>,
) {
	const binding = draft.screen?.storage;
	if (!binding) {
		if (plan && !draft.workflow)
			throw new AppStorageDefinitionError(
				"app_storage_screen_required",
				"screen.storage",
				"screen.storage に {collection, inputs} を置いてください。collection は storage.collections[].id、inputs はフォームの各項目IDからスキーマの列名への対応です。",
			);
		return;
	}
	const collection = plan?.collections.find(
		({ id }) => id === binding.collection,
	);
	if (!collection)
		throw new AppStorageDefinitionError(
			"app_storage_collection_not_found",
			"screen.storage.collection",
			"storage.collections の id で定義した保存先を指定してください。",
		);
	const screen = draft.screen!;
	const fields =
		fieldsOfDefinition(screen.definition as Record<string, unknown>) ?? [];
	const mapping = Object.entries(binding.inputs);
	const writable = collection.operations.some(
		(op) => op === "create" || op === "update",
	);
	if (
		new Set(Object.values(binding.inputs)).size !== mapping.length ||
		(writable &&
			(!fields.length ||
				fields.some(({ id }) => !Object.hasOwn(binding.inputs, id)) ||
				collection.columns.some(
					({ name, required }) =>
						required && !Object.values(binding.inputs).includes(name),
				))) ||
		(!writable && fields.length) ||
		mapping.some(([field, name]) => {
			const input = fields.find(({ id }) => id === field);
			const column = collection.columns.find(({ name: key }) => key === name);
			if (!input || !column) return true;
			if (input.type === "number")
				return column.type !== "number" && column.type !== "integer";
			if (input.type === "boolean") return column.type !== "boolean";
			return input.type === "checkbox"
				? column.type !== "array"
				: column.type !== "string";
		}) ||
		Object.keys(
			(screen.bindings as { inputs?: Record<string, string> } | undefined)
				?.inputs ?? {},
		).length
	)
		throw new AppStorageDefinitionError(
			"app_storage_screen_invalid",
			"screen.storage.inputs",
			"フォームの項目IDと列名を重複なく対応させ、必須の列を全て割り当ててください。フォームの型を列の型に合わせ、同じフォームを bindings.inputs にも割り当てないでください。",
		);
}
