import type { Database } from "bun:sqlite";
import { z } from "zod";
import {
	appDigest,
	appDraft,
	checkAppDraft,
	type AppDevelopment,
	type AppDraft,
} from "../../domains/app-development";
import {
	WorkflowPipelineError,
	workflowRevisionInTransaction,
} from "../../domains/pipelines";
import type { DomainAdapter } from "../../domains/tool-runtime";
import {
	prepareWorkflowScreen,
	saveWorkflowScreenInTransaction,
	UiCompositionError,
	workflowScreenInTransaction,
} from "../../domains/ui-compositions";
import type {
	createWorkflowAuthoring,
	WorkflowAuthoringSource,
} from "../pipelines/workflow-authoring";

export const APP_ADAPTER = "adapter:app-development@1";
const studio = "query:app-development.studio@1";
const workspace = "workspace:app-development.definition@1";
const schemaRef = (key: string) => `domain:app-development.${key}@1`;
const inputRef = (key: string) => `input:app-development.${key}@1`;
const number = z
	.union([
		z.number(),
		z
			.string()
			.regex(/^\d{1,9}$/)
			.transform(Number),
	])
	.pipe(z.number().int().nonnegative());
const workInput = z.object({ workRef: z.uuid(), expectedRevision: number });
const inputs = {
	save: workInput.extend({
		expectedSavedRevision: number,
		digest: z.string().regex(/^[0-9a-f]{64}$/),
	}),
	source: workInput.extend({ text: z.string().min(1).max(96_000) }),
	run: z.object({
		appId: z.uuid(),
		revision: number,
		values: z.string().min(2).max(12000),
	}),
	schedule: z.object({
		appId: z.uuid(),
		revision: number,
		anchor: z.iso.datetime({ offset: true }),
	}),
	cancel: z.object({ appId: z.uuid(), revision: number, runId: z.uuid() }),
	reconcile: z.object({ appId: z.uuid(), revision: number, runId: z.uuid() }),
	stop: z.object({ appId: z.uuid(), revision: number }),
};
export const appDevelopmentDomainSchemas = {
	...Object.fromEntries(
		Object.entries(inputs).map(([key, schema]) => [schemaRef(key), schema]),
	),
	"domain:app-development.receipt@1": z.object({
		state: z.string(),
		projectId: z.string().optional(),
	}),
};
type Operation = keyof typeof inputs;
const nameOf = (key: Operation) => `app-development.${key}`;
const draftIssue = (error: unknown) =>
	error instanceof Error && /^[a-z_]+$/.test(error.message)
		? error.message
		: "app_definition_invalid";

export const describeAppDevelopmentAdapter = () => ({
	owner: "app-development",
	operations: new Map(
		Object.keys(inputs).map((key) => [
			nameOf(key as Operation),
			{ inputSchemaRef: schemaRef(key), effect: "write" as const },
		]),
	),
	queries: new Set([studio]),
	inputAdapters: new Map(
		Object.entries(inputs).map(([key, validator]) => [
			inputRef(key),
			(raw: Record<string, unknown>) => {
				const parsed = validator.safeParse(raw);
				return parsed.success
					? { ok: true as const, value: parsed.data }
					: {
							ok: false as const,
							errors: parsed.error.issues.slice(0, 8).map((issue) => ({
								field: issue.path.join("."),
								message: "入力を確認してください",
							})),
						};
			},
		]),
	),
	projections: new Set<string>(),
	availability: "availability:app-development@1",
	workspaces: new Map([
		[workspace, { path: "definition.json", mediaType: "application/json" }],
	]),
});

type App = NonNullable<ReturnType<AppDevelopment["app"]>>;
type Work = ReturnType<AppDevelopment["draft"]>;
export type AppWorkflowControls = {
	run(
		db: Database,
		app: App,
		operationId: string,
		values: unknown,
	): Record<string, unknown>;
	schedule(
		db: Database,
		app: App,
		operationId: string,
		anchor: string,
	): Record<string, unknown>;
	cancel(db: Database, app: App, runId: string): Record<string, unknown>;
	reconcile(db: Database, app: App, runId: string): Record<string, unknown>;
	stop(db: Database, app: App): Record<string, unknown>;
	view(db: Database, app: App): { status: unknown; data: unknown };
	wake(): void;
};

type AdapterDependencies = {
	authoring(): ReturnType<typeof createWorkflowAuthoring>;
	workflow(): AppWorkflowControls;
	turn(
		db: Database,
		runId: string,
		sessionId: string,
	): { request: string; conversationId: string } | null;
	sessionLive(db: Database, id: string): boolean;
	context(db: Database): unknown;
	grantDigest(publishKind: unknown): string;
};

export function createAppDevelopmentAdapter(
	service: AppDevelopment,
	deps: AdapterDependencies,
): DomainAdapter {
	const preview = createAppPreview(service, deps.authoring, deps.grantDigest);
	function requiredApp(db: Database, appId: string, revision: number) {
		const app = service.app(db, appId);
		if (!app || app.revision !== revision || !app.workflowRevision)
			throw new Error("app_revision_conflict");
		return app;
	}
	const state = (db: Database, workRef: string) => {
		const value = service.state(db, workRef);
		return value ? { ...value, context: deps.context(db) } : null;
	};
	return {
		ref: APP_ADAPTER,
		describe: describeAppDevelopmentAdapter,
		availableInTransaction: () => true,
		snapshotInTransaction: (db) => ({ items: service.list(db) }),
		choicesInTransaction: (db, ref) =>
			ref === "builtin:uiTargetRef"
				? service
						.list(db)
						.slice(0, 20)
						.map(({ id, title }) => ({ ref: id, label: title }))
				: [],
		invokeInTransaction(db, request) {
			if (
				request.origin.kind !== "ui" ||
				request.origin.scope !== service.scope
			)
				throw new Error("origin_not_allowed");
			const { requestId, operationName, input } = request;
			const digest = appDigest([operationName, input]);
			const prior = service.receipt(db, requestId);
			if (prior) {
				if (prior.digest !== digest) throw new Error("request_conflict");
				return receipt(prior.value, requestId, true);
			}
			let value: Record<string, unknown>;
			switch (operationName) {
				case "app-development.source": {
					const data = inputs.source.parse(input);
					const work = service.draft(db, data.workRef);
					if (!deps.sessionLive(db, work.sessionId))
						throw new Error("session_expired");
					const check = checkAppDraft(data.text);
					if (!check.ok) throw new Error(check.code);
					value = {
						state: "drafted",
						...service.commit(db, data.workRef, {
							revision: data.expectedRevision,
							value: check.value,
						}),
					};
					break;
				}
				case "app-development.save": {
					const data = inputs.save.parse(input);
					const work = service.draft(db, data.workRef);
					if (!deps.sessionLive(db, work.sessionId))
						throw new Error("session_expired");
					if (
						work.busy ||
						work.revision !== data.expectedRevision ||
						work.savedRevision !== data.expectedSavedRevision
					)
						throw new Error("revision_conflict");
					const checked = preview(db, work);
					if (checked.digest !== data.digest)
						throw new Error("workflow_confirmation_changed");
					const saved = checked.args
						? deps
								.authoring()
								.confirmInTransaction(
									db,
									checked.args.source,
									checked.args.input,
									requestId,
									checked.workflowDigest!,
								)
						: null;
					const screen = checked.screen
						? saveWorkflowScreenInTransaction(
								db,
								{ scope: service.scope, workflowId: work.appId },
								checked.screen,
							)
						: null;
					const app = service.publish(db, {
						workRef: data.workRef,
						draftRevision: data.expectedRevision,
						expectedSavedRevision: data.expectedSavedRevision,
						digest: checked.digest,
						workflowRevision: saved?.revision ?? null,
						screenRevision:
							screen?.revision ?? saved?.value.artifact?.revision ?? null,
					});
					value = {
						state: "saved",
						projectId: app.appId,
						revision: app.revision,
					};
					break;
				}
				case "app-development.run": {
					const data = inputs.run.parse(input);
					value = deps
						.workflow()
						.run(
							db,
							requiredApp(db, data.appId, data.revision),
							requestId,
							JSON.parse(data.values),
						);
					break;
				}
				case "app-development.schedule": {
					const data = inputs.schedule.parse(input);
					value = deps
						.workflow()
						.schedule(
							db,
							requiredApp(db, data.appId, data.revision),
							requestId,
							data.anchor,
						);
					break;
				}
				case "app-development.cancel": {
					const data = inputs.cancel.parse(input);
					value = deps
						.workflow()
						.cancel(db, requiredApp(db, data.appId, data.revision), data.runId);
					break;
				}
				case "app-development.reconcile": {
					const data = inputs.reconcile.parse(input);
					value = deps
						.workflow()
						.reconcile(
							db,
							requiredApp(db, data.appId, data.revision),
							data.runId,
						);
					break;
				}
				case "app-development.stop": {
					const data = inputs.stop.parse(input);
					value = deps
						.workflow()
						.stop(db, requiredApp(db, data.appId, data.revision));
					break;
				}
				default:
					throw new Error("app_operation_unknown");
			}
			service.saveReceipt(db, requestId, digest, value);
			return receipt(value, requestId, false);
		},
		readInTransaction(db, operationId) {
			const saved = service.receipt(db, operationId);
			return saved ? receipt(saved.value, operationId, true) : null;
		},
		sourceInTransaction(db, query, targetRef) {
			if (query !== studio) return null;
			const work = service.current(db);
			const viewing = targetRef ? service.app(db, targetRef) : null;
			const screen = viewing?.screenRevision
				? workflowScreenInTransaction(
						db,
						{ scope: service.scope, workflowId: viewing.appId },
						viewing.workflowRevision
							? `${viewing.appId}.workflow`
							: viewing.appId,
						viewing.screenRevision,
					)?.value
				: null;
			let confirmation = null,
				issue: string | null = null;
			if (work?.draft && !work.busy && work.dirty) {
				try {
					const checked = preview(db, work);
					confirmation = { digest: checked.digest, summary: checked.summary };
				} catch (error) {
					issue = draftIssue(error);
				}
			}
			const live = viewing?.workflowRevision
				? deps.workflow().view(db, viewing)
				: null;
			const data = {
				kind: "ui-studio",
				work: work
					? {
							workRef: work.id,
							sessionId: work.sessionId,
							title: work.draft?.title ?? "",
							definition: work.draft?.screen?.definition ?? null,
							revision: work.revision,
							source: work.draft ? JSON.stringify(work.draft, null, 2) : "",
							previousSource: "",
							rejected: work.rejected,
							savedRef: work.savedRevision ? work.appId : null,
							savedRevision: work.savedRevision,
							busy: work.busy,
							dirty: work.dirty,
							canUndo: false,
							canRedo: false,
							confirmation,
							issue,
						}
					: null,
				viewing: viewing
					? {
							id: viewing.appId,
							title: viewing.title,
							definition: screen?.definition ?? null,
							storedDefinition: viewing.draft,
							savedRevision: viewing.revision,
							bindings: screen?.bindings ?? null,
							workflow: viewing.draft.workflow ?? null,
							...live,
						}
					: null,
				history: service.list(db),
			};
			return {
				revision: Math.max(1, work?.revision ?? 0, viewing?.revision ?? 0),
				data,
			};
		},
		targetInput: () => ({}),
		afterCommit: () => deps.workflow().wake(),
		session: {
			hasTargetInTransaction: (db, id) => !!service.app(db, id),
			openInTransaction: (db, input) => ({
				...service.open(db, input),
				context: deps.context(db),
			}),
			stateInTransaction: state,
			beginTurnInTransaction: service.begin,
			endTurnInTransaction: service.endTurn,
			endInTransaction: service.end,
			document: createAppDocument(service, deps, preview),
		},
	};
}

function createAppDocument(
	service: AppDevelopment,
	deps: AdapterDependencies,
	preview: ReturnType<typeof createAppPreview>,
): NonNullable<NonNullable<DomainAdapter["session"]>["document"]> {
	return {
		readInTransaction(db, workRef) {
			if (!service.state(db, workRef)) return null;
			const work = service.draft(db, workRef);
			return {
				revision: work.revision,
				title: work.draft?.title ?? "",
				text: work.draft ? JSON.stringify(work.draft, null, 2) : "",
				rejected: work.rejected as never,
			};
		},
		check: checkAppDraft,
		commitInTransaction(db, workRef, input) {
			if (
				input.origin.kind !== "specialist" ||
				input.origin.workRef !== workRef
			)
				throw new Error("origin_not_allowed");
			const { runId, sessionId } = input.origin;
			const source = deps.turn(db, runId, sessionId);
			if (!source) throw new Error("app_source_unavailable");
			const work = service.draft(db, workRef);
			const draft = appDraft.parse(input.value);
			try {
				preview(db, {
					...work,
					draft,
					request: work.request ?? source.request,
					conversationId: work.conversationId ?? source.conversationId,
				});
			} catch (error) {
				const code = draftIssue(error);
				const issues =
					error instanceof WorkflowPipelineError
						? error.issues
						: error instanceof z.ZodError
							? error.issues.slice(0, 8).map((issue) => ({
									path: issue.path.join(".") || "(root)",
									rule: issue.code,
									...(issue.code === "unrecognized_keys"
										? { keys: issue.keys }
										: {}),
								}))
							: [
									{
										path:
											error instanceof UiCompositionError
												? "screen.definition"
												: "(root)",
										rule: code,
										...(error instanceof UiCompositionError && error.detail
											? { detail: error.detail }
											: {}),
									},
								];
				service.reject(db, workRef, {
					title: draft.title,
					text: JSON.stringify(draft, null, 2),
					issues,
					fixes: [],
				});
				throw Object.assign(new Error(code), {
					code,
					documentIssues: issues,
				});
			}
			return service.commit(db, workRef, {
				revision: input.baseRevision,
				value: draft,
				turn: { runId, sessionId, ...source },
			});
		},
		rejectInTransaction: service.reject,
	};
}

function createAppPreview(
	service: AppDevelopment,
	authoring: AdapterDependencies["authoring"],
	grantDigest: AdapterDependencies["grantDigest"],
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
		if (typeof sourceUrl === "string" && !work.request.includes(sourceUrl))
			throw new WorkflowPipelineError([
				{
					path: "workflow.input.fixed.sourceUrl",
					rule: "workflow_source_url_unconfirmed",
					detail: "依頼にURLの指定がありません。sourceUrlを省略してください。",
				},
			]);
		const source: WorkflowAuthoringSource = {
			scope: service.scope,
			workflowId: work.appId,
			conversationId: work.conversationId,
			sourceRequest: work.request,
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
				pipeline: { ...pipeline, request: work.request },
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
		if (draft.workflow) {
			const args = draftArguments(db, work, draft);
			const checked = authoring().previewInTransaction(
				db,
				args.source,
				args.input,
			);
			return {
				digest: appDigest([work.revision, draft.title, checked.digest]),
				args,
				workflowDigest: checked.digest,
				summary: checked.definition,
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
			digest: appDigest([work.revision, draft.title, checked.digest]),
			screen,
			summary: null,
		};
	};
}

function receipt(
	value: Record<string, unknown>,
	operationId: string,
	replay: boolean,
) {
	return {
		receipt: value,
		receiptRef: {
			owner: "app-development",
			operationId,
			digest: appDigest(value),
		},
		resultRefs:
			typeof value.projectId === "string"
				? [
						{
							owner: "app-development",
							kind: "app",
							id: value.projectId,
							schemaRef: "domain:app-development.receipt@1",
						},
					]
				: [],
		answerContext: { state: value.state, projectId: value.projectId },
		replay,
	};
}
