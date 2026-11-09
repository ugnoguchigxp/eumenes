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
	const adapter = createAppDevelopmentAdapter(apps, {
		authoring: () => authoring,
		workflow: () => workflow,
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
						maker: "Eumenesアプリ開発",
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
		recover: () => workflow.recover(),
	};
}
