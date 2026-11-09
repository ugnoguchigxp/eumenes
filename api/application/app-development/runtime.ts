import type { Database } from "bun:sqlite";
import type { PendingSave } from "../../domains/app-development";
import { createAppStorageRuntime } from "./storage-runtime";
import type { AgentRuntime } from "../../domains/agent-runtime";
import {
	appDigest,
	createAppDevelopment,
	forgetWorkflowWebRoute,
	readWorkflowWebRoute,
	rememberWorkflowWebRoute,
} from "../../domains/app-development";
import type { Capabilities } from "../../domains/capabilities";
import type { DialogueService } from "../../domains/dialogue";
import type { createGitObservation } from "../../domains/git-observation";
import type { InferencePort } from "../../domains/inference";
import type { MarkdownService } from "../../domains/markdown";
import type { QueueService } from "../../domains/queue";
import type { SchedulerService } from "../../domains/scheduler";
import { scratchUri, type ScratchStore } from "../../domains/scratch";
import type { WebResearchService } from "../../domains/web-research";
import type { SqliteStore } from "../../infrastructure/sqlite";
import { createWorkflowAuthoring } from "../pipelines/workflow-authoring";
import { createWorkflowExecutionAuthority } from "../pipelines/workflow-execution-source";
import { createWorkflowStepExecution } from "../pipelines/workflow-step-execution";
import { createAppDevelopmentAdapter } from "./app-development-adapter";
import { createAppWorkflowControls } from "./workflow-controls";
import {
	createWorkflowOperations,
	journalDestination,
} from "./workflow-operations";

export function createAppDevelopmentRuntime(deps: {
	store: SqliteStore;
	queue: QueueService;
	scheduler: SchedulerService;
	markdown: MarkdownService;
	scratch?: ScratchStore;
	web: WebResearchService;
	inference: InferencePort;
	git: ReturnType<typeof createGitObservation>;
	destination(): {
		namespace: string;
		path: string;
		binding?: string | null;
	} | null;
	storageRoot: string;
	storageChanged?(): void;
	now?: () => number;
}) {
	const {
		store,
		queue,
		scheduler,
		markdown,
		scratch,
		web,
		inference,
		git,
		destination,
	} = deps;
	const now = deps.now ?? Date.now;
	const apps = createAppDevelopment("default", now);
	const grantDigest = (kind: unknown) =>
		appDigest(
			kind === "markdown" ? [kind, destination()] : [kind, "protected-web"],
		);
	let authoring: ReturnType<typeof createWorkflowAuthoring>;
	let workflow: ReturnType<typeof createAppWorkflowControls>;
	let operations: ReturnType<typeof createWorkflowOperations>;
	let dialogue:
		| Pick<
				DialogueService,
				| "specialistExecutionSourceInTransaction"
				| "specialistSessionLiveInTransaction"
		  >
		| undefined;
	const authority = createWorkflowExecutionAuthority({
		now,
		authorized(db, saved, run) {
			return (
				!!apps.app(db, run.workflowId) &&
				saved.value.grant?.authorityDigest ===
					grantDigest(saved.value.definition.publish.kind) &&
				(saved.value.definition.publish.kind === "dataset" || !!destination())
			);
		},
	});
	const publishStorage = (
		db: Database,
		operationId: string,
		save: PendingSave,
	) => adapter.finishSave(db, operationId, save);
	const storage = createAppStorageRuntime({
		store,
		queue,
		apps,
		root: deps.storageRoot,
		workflow: () => workflow,
		publish: publishStorage,
		changed: deps.storageChanged,
	});
	const adapter = createAppDevelopmentAdapter(apps, {
		authoring: () => authoring,
		workflow: () => workflow,
		storage: () => storage,
		turn: (db, runId, sessionId) =>
			dialogue?.specialistExecutionSourceInTransaction(db, runId, sessionId) ??
			null,
		sessionLive: (db, sessionId) =>
			dialogue?.specialistSessionLiveInTransaction(db, sessionId) ?? false,
		context: () => operations?.operationInfo(),
		grantDigest,
	});
	return {
		apps,
		adapter,
		attach(deps: {
			capabilities: Capabilities;
			agents: AgentRuntime["executions"];
		}) {
			const { capabilities, agents } = deps;
			operations = createWorkflowOperations({
				inference,
				web,
				git,
				capabilities,
				authority,
				webRoutes: {
					read: readWorkflowWebRoute,
					change: (child, signal, key, url, forget) =>
						store.write((db) => {
							signal.throwIfAborted();
							if (!agents.authorizeChildInTransaction(db, child))
								throw new Error("execution_source_invalid");
							if (forget) forgetWorkflowWebRoute(db, key, url);
							else rememberWorkflowWebRoute(db, key, url);
						}),
				},
				journalAvailable: () => !!destination(),
				storage: (child, signal, collection, request) =>
					store.write((db) => {
						signal.throwIfAborted();
						const resolved = authority.runInTransaction(db, child.source);
						const app = resolved && apps.app(db, resolved.run.workflowId);
						if (
							!app ||
							!resolved ||
							app.workflowRevision !== resolved.run.revision ||
							!agents.authorizeChildInTransaction(db, child)
						)
							throw new Error("execution_source_invalid");
						const result = storage.records(
							db,
							app,
							collection,
							request,
							child.id,
						);
						const refs = (records: Array<{ id: string; revision?: number }>) =>
							records.map(({ id, revision }) => ({
								id,
								...(revision === undefined ? {} : { revision }),
							}));
						return "rows" in result
							? {
									collection,
									records: refs(result.rows),
									hasMore: result.hasMore,
								}
							: { collection, records: refs([result]) };
					}),
			});
			authoring = createWorkflowAuthoring({
				store,
				capabilities,
				catalog: operations.authoringCatalog,
				mayConfirm: (_db, source, definition) =>
					source.scope === apps.scope &&
					source.grantDigest === grantDigest(definition.publish.kind) &&
					(definition.publish.kind === "dataset" ||
						(definition.publish.destinationRef === journalDestination &&
							!!destination())),
			});
			workflow = createAppWorkflowControls({
				store,
				queue,
				scheduler,
				apps,
				capabilities,
				agents,
				authority,
				operations,
				markdown,
				destination,
				now,
			});
			markdown.generated.configureOwner("workflow", {
				validInTransaction: workflow.validDocument,
				async writeLocal(input, signal) {
					signal.throwIfAborted();
					if (!scratch) throw new Error("scratch_unavailable");
					const item = await scratch.put({
						id: input.id,
						conversationId: input.conversationId,
						name: `${input.id}.md`,
						mime: "text/markdown",
						data: new TextEncoder().encode(input.markdown),
						origin: "written",
						maker: "Webアプリ開発",
						internal: true,
					});
					return scratchUri(item.id);
				},
				hasLocal: (id) => !!scratch?.get(id),
				forgetLocal(id) {
					const item = scratch?.get(id);
					if (item) scratch?.forgetWritten(id, item.conversationId);
				},
			});
			return {
				workflowAuthority: authority,
				workflowCatalog: operations,
				workflowSteps: createWorkflowStepExecution({
					authority,
					agents,
					operations: operations.operations,
					schema: (db, child, ref) =>
						operations.schema(db, ref, {
							scope: apps.scope,
							workflowId: child.source.workflow?.definitionId ?? "",
						}),
				}),
			};
		},
		attachDialogue(value: typeof dialogue) {
			dialogue = value;
		},
		recover: async () => {
			await storage.recover();
			await workflow.recover();
		},
	};
}
