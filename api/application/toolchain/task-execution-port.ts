import { executionNoticeResult } from "../../domains/tool-runtime";
import type { AgentRuntime } from "../../domains/agent-runtime";
import { type Capabilities } from "../../domains/capabilities";
import type { ConversationService } from "../../domains/conversation";
import type {
	DialogueService,
	ToolchainRoutingPort,
} from "../../domains/dialogue";
import type { InferencePort } from "../../domains/inference";
import type { MemoryService } from "../../domains/memory";
import type { Database } from "bun:sqlite";
import type {
	AdapterRegistry,
	ChildExecution,
	ExecutionView,
	ToolchainExecutionPort,
} from "../../domains/tool-runtime";
import type { SqliteStore } from "../../infrastructure/sqlite";
import { taskChildContext } from "./task-execution-catalog";
import { taskExecutionDispatch } from "./task-execution-dispatch";
import { taskExecutionSources } from "./task-execution-sources";
import { taskExecutionStops } from "./task-execution-stops";
import { reference, result, total } from "./task-execution-values";

export type TaskExecutionHost = {
	queue: import("../../domains/queue").QueueService;
	store: SqliteStore;
	capabilities: Capabilities;
	agents: AgentRuntime;
	routing: ToolchainRoutingPort;
	registry: AdapterRegistry;
	dialogue: DialogueService;
	conversation: ConversationService;
	memory?: MemoryService;
	inference: InferencePort;
	media?: import("./task-media-execution").TaskMediaPorts;
	legacy?: import("./task-legacy-execution").TaskLegacyPorts;
	browser?: import("../../domains/browser").BrowserService;
	childOperations?: import("../../domains/tool-runtime").ChildOperationPort;
	/** Resolves the `resource` references handed to sub-agents (absent: such a reference is invalid). */
	resources?: import("../../domains/resources").ResourceRegistry;
};

/**
 * Sends an execution's notice to its conversation (the conversation answers it as a background run). False when
 * the execution no longer has a dialogue source (nothing to answer).
 */
export function sendExecutionNotice(
	host: {
		dialogue: Pick<
			DialogueService,
			"executionSourceInTransaction" | "notifyInTransaction"
		>;
		agents: {
			executions: Pick<AgentRuntime["executions"], "sourceRunInTransaction">;
		};
	},
	db: Database,
	view: ExecutionView,
	eventId: string,
): boolean {
	const { dialogue, agents } = host;
	if (
		!dialogue.executionSourceInTransaction(
			db,
			agents.executions.sourceRunInTransaction(db, view.id) ?? "",
		)
	)
		return false;
	dialogue.notifyInTransaction(db, {
		requestId: eventId,
		conversationId: view.conversationId,
		text: JSON.stringify({
			kind: view.question ? "task_question" : "task_result",
			workRef: view.id,
			revision: view.revision,
			status: view.status,
			request: view.request.slice(0, 500),
			question: view.question,
			result: executionNoticeResult(view.result),
		}),
	});
	return true;
}
/** Composition of public operations. Only execution types dispatch here; the model chooses the purpose. */
export function configureTaskExecution(host: TaskExecutionHost) {
	const {
		store,
		capabilities,
		agents,
		routing,
		registry,
		dialogue,
		conversation,
		memory,
		inference,
	} = host;
	const stopExternal = taskExecutionStops(host.queue, registry, agents);
	const context = taskChildContext(host);
	const { available, resolve, bound, research } = context;
	const port: ToolchainExecutionPort = {
		childOperations: host.childOperations,
		childDeadlineInTransaction(db, revisionId, deadline) {
			const binding = capabilities.toolchainBindingInTransaction(db, revisionId)
				?.binding.document;
			const limit =
				binding && "timeLimits" in binding
					? binding.timeLimits?.runMs
					: undefined;
			return limit ? Math.min(deadline, Date.now() + limit) : deadline;
		},
		...taskExecutionSources(host, context),
		cardInTransaction: routing.cardInTransaction,
		async find(query, source, signal) {
			const vector = await routing.embedQuery(query, signal);
			if (!vector) throw new Error("embedding_unavailable");
			return store.read(
				(db) =>
					routing.routeInTransaction(db, {
						runId: source.runId,
						text: query,
						query: vector,
						available: new Set(available(db, source.runId).map((e) => e.id)),
						strict: true,
					}).cards,
			);
		},
		...taskExecutionDispatch(host, context, (db, source, ref, start, limit) =>
			port.readReferenceInTransaction(db, source, ref, start, limit),
		),
		currentInTransaction(db, child, raw) {
			if (raw === null)
				return result(
					"cancelled",
					{ kind: "research" },
					"dispatch_not_started",
					total(child, 0),
				);
			const ref = reference.parse(raw);
			if (ref.kind === "research") return research(db, child, ref.calls ?? 0);
			if (ref.kind === "bound") return bound(db, child, raw);
			if (ref.kind === "media")
				return host.media!.currentInTransaction(db, child, raw);
			if (ref.kind === "legacy")
				return host.legacy!.currentInTransaction(db, child, raw);
			return result(
				"failed",
				raw,
				"execution_result_unavailable",
				total(child, 0),
			);
		},
		adoptInTransaction(db, child, outcome) {
			resolve(db, child);
			const ref = reference.parse(outcome.ref);
			if (ref.kind === "research" && outcome.state !== "running")
				return (
					["failed", "cancelled", "expired"].includes(outcome.state) ||
					agents.adoptExecutionChildInTransaction(db, ref.dispatchId!)
				);
			return true;
		},
		cancelInTransaction(db, child, raw) {
			const dispatched = agents.executionChildReceiptInTransaction(
				db,
				child.dispatchId ?? child.id,
			);
			if (!raw && dispatched?.action) {
				const command = JSON.parse(dispatched.root.input_json ?? "{}")
					.command as { adapterRef?: string } | undefined;
				if (command?.adapterRef) {
					registry
						.get(command.adapterRef)
						?.execution?.cancelInTransaction(
							db,
							dispatched.action.operation_id,
							child,
						);
					stopExternal(
						db,
						command.adapterRef,
						dispatched.action.operation_id,
						child,
					);
				}
			}
			agents.cancelExecutionChildInTransaction(
				db,
				child.dispatchId ?? child.id,
			);
			if (!raw) {
				host.media?.cancelInTransaction(db, child, null);
				return;
			}
			const ref = reference.parse(raw);
			if (ref.kind === "bound" && ref.operationId && ref.adapterRef) {
				registry
					.get(ref.adapterRef)
					?.execution?.cancelInTransaction(db, ref.operationId, child);
				stopExternal(db, ref.adapterRef, ref.operationId, child);
			}
			if (ref.kind === "media") host.media?.cancelInTransaction(db, child, raw);
			if (ref.kind === "legacy")
				host.legacy?.cancelInTransaction(db, child, raw);
		},
		validateAnswerInTransaction(db, child, outcome, input) {
			const ref = reference.parse(outcome.ref);
			if (ref.kind === "bound" && ref.operationId && ref.adapterRef)
				return (
					registry
						.get(ref.adapterRef)
						?.execution?.validateAnswerInTransaction(
							db,
							ref.operationId,
							input,
						) ?? false
				);
			if (ref.kind === "research")
				return (
					typeof input === "string" && input.length > 0 && input.length <= 8000
				);
			if (ref.kind === "legacy")
				return (
					host.legacy?.validateAnswerInTransaction(
						db,
						child,
						outcome.ref,
						input,
					) ?? false
				);
			if (ref.kind !== "question") return false;
			return dialogue.executionCommands.validateAnswer(
				routing.commandSetInTransaction(db, child.chainRevisionId).binding,
				ref.answerSchema!,
				input,
			);
		},
		purgeSourcesInTransaction(db, source, children) {
			agents.deleteTaskDataInTransaction(db, source.runId);
			for (const child of children)
				host.media?.purgeCallInTransaction(db, child.id);
			host.browser?.purgeTaskExecutionInTransaction(
				db,
				children[0]?.executionId ?? "",
			);
		},
		flush: () => {
			for (const adapter of registry.all()) adapter.afterCommit?.();
		},
		revokeDeliveryInTransaction: dialogue.revokeExecutionNoticeInTransaction,
		deliveryStateInTransaction: dialogue.noticeDeliveryInTransaction,
		deliverInTransaction(db, view, eventId) {
			if (
				!dialogue.executionSourceInTransaction(
					db,
					agents.executions.sourceRunInTransaction(db, view.id) ?? "",
				)
			)
				return true;
			sendExecutionNotice(host, db, view, eventId);
			return false;
		},
		// A run follows the revision it started from (its definition is frozen in the run): a later revision of the
		// same pipeline does not stop it; withdrawing the pipeline or its adapter does.
		pipelineInTransaction(db, toolchainRevisionId) {
			const id = /^toolchain:(.+)@[1-9][0-9]*$/.exec(toolchainRevisionId)?.[1];
			if (
				!id ||
				!capabilities.toolchainsInTransaction(db).some((d) => d.id === id)
			)
				return null;
			const bound = capabilities.toolchainBindingInTransaction(
				db,
				toolchainRevisionId,
			);
			const binding = bound?.binding.document;
			if (
				binding?.execution !== "pipeline" ||
				!registry.get(binding.adapterRef)?.availableInTransaction(db)
			)
				return null;
			return {
				bindingRevisionId: bound!.binding.revisionId,
				definition: binding.pipeline,
				runMs: binding.timeLimits.runMs,
			};
		},
		stepToolchainInTransaction: (db, toolchainId, source) =>
			available(db, source.runId).find((e) => e.id === toolchainId)
				?.revisionId ?? null,
		controlInTransaction(db) {
			const sets = capabilities.toolchainsInTransaction(db).flatMap((d) => {
				const bound = capabilities.toolchainBindingInTransaction(
					db,
					d.revisionId,
				);
				return bound?.binding.document.execution === "task"
					? [capabilities.toolchainSetInTransaction(db, d.revisionId)]
					: [];
			});
			if (
				sets.length !== 1 ||
				!inference.captureUserControlInTransaction ||
				!inference.executeStream
			)
				return null;
			const set = sets[0]!,
				binding = set.binding!.document;
			if (binding.execution !== "task") return null;
			return {
				revisionId: set.binding!.revisionId,
				instructions: [set.profile, ...set.skills].join("\n\n"),
				runMs: binding.timeLimits.runMs,
				limits: binding.limits,
			};
		},
	};
	agents.executions.configure(port);
	host.browser?.setTaskExecutionSource((db, frozen) => {
		const child = (frozen as { execution?: ChildExecution } | null)?.execution;
		if (!child || !agents.executions.authorizeChildInTransaction(db, child))
			return null;
		if (
			!port.validSourceInTransaction(db, child.source) ||
			child.refs.some(
				(ref) => !port.validReferenceInTransaction(db, child.source, ref),
			)
		)
			return null;
		const answer = child.resume
			? conversation.messageInTransaction(db, child.resume.answerMessageId)
					?.message
			: null;
		if (
			child.resume &&
			(!answer ||
				answer.role !== "user" ||
				answer.conversationId !== child.source.conversationId ||
				memory
					?.blockedMessageIdsOfConversationInTransaction(
						db,
						child.source.conversationId,
					)
					.includes(answer.id))
		)
			return null;
		return [
			child.source.request,
			...(child.source.amendments ?? []).map((update) => update.request),
			...(child.source.responses ?? []).map((update) => update.request),
			...(answer ? [answer.text] : []),
		].join("\n");
	});
	return port;
}
