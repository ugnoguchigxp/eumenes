import type { Database } from "bun:sqlite";
import { z } from "zod";
import { withinJsonLimits } from "eumenes-collaboration";
import type { AgentRuntime } from "../../domains/agent-runtime";
import type { Capabilities } from "../../domains/capabilities";
import type { BrowserInteractService } from "../../domains/browser";
import type { ChildView, Ports, Source } from "../../domains/collaboration";
import { CONVERSATION_DEFAULT_PRINCIPAL } from "../../domains/conversation/contracts";
import type { DialogueService } from "../../domains/dialogue";
import { checkPipelineDefinition } from "../../domains/pipelines";
import type {
	ExecutionSource,
	ExecutionView,
	ToolchainExecutionPort,
} from "../../domains/tool-runtime";

export type CollaborationInteract = BrowserInteractService & {
	setCollaborationSourceGuard(
		guard: (db: Database, source: unknown) => boolean,
	): void;
};
type InteractView = ReturnType<BrowserInteractService["statusInTransaction"]>;
const owner = CONVERSATION_DEFAULT_PRINCIPAL;
const sourceWithHistory = (
	source: Source,
	history: Source[],
): ExecutionSource => ({
	...source,
	responses: history
		.filter((item) => item.messageId !== source.messageId)
		.map(({ messageId, request, digest }) => ({ messageId, request, digest })),
});
function pipelineView(view: ExecutionView): ChildView {
	const status =
		view.status === "queued" ||
		view.status === "deciding" ||
		view.status === "waiting_child"
			? "running"
			: view.status === "waiting_user"
				? "waiting_user"
				: view.status === "interrupted"
					? "failed"
					: view.status;
	return {
		id: view.id,
		status,
		revision: view.revision,
		...(view.result?.summary !== undefined
			? { summary: view.result.summary }
			: {}),
		...(view.question
			? {
					question: {
						id: view.question.id,
						prompt: view.question.prompt,
						approval: false,
						revision: view.revision,
						...(view.question.expiresAt !== undefined
							? { expiresAt: view.question.expiresAt }
							: {}),
					},
				}
			: {}),
	};
}
function interactView(view: InteractView): ChildView {
	const status =
		view.state === "needs_input"
			? "waiting_user"
			: view.state === "queued" || view.state === "running"
				? "running"
				: view.state === "expired"
					? "failed"
					: view.state;
	return {
		id: view.runId,
		status,
		revision: view.revision,
		...(view.answer !== null || view.code !== null
			? { summary: view.answer ?? view.code! }
			: {}),
		...(view.question
			? {
					question: {
						id: view.question.id,
						prompt: view.question.text,
						approval: view.question.kind !== "text",
						revision: view.revision,
						generation: view.generation,
						...(view.question.deadline !== null
							? { expiresAt: view.question.deadline }
							: {}),
					},
				}
			: {}),
	};
}

/** Public execution operations only: no domain tables or independent execution loop. */
export function collaborationBackends(deps: {
	dialogue: DialogueService;
	agents: AgentRuntime;
	capabilities: Capabilities;
	execution: ToolchainExecutionPort;
	interact?: CollaborationInteract;
	interactAvailable(db: Database): boolean;
}): Ports {
	const { dialogue, agents, execution, interact } = deps;
	interact?.setCollaborationSourceGuard((db, source) => {
		try {
			return (
				source !== null &&
				typeof source === "object" &&
				withinJsonLimits(source) &&
				execution.validSourceInTransaction(db, source as ExecutionSource)
			);
		} catch {
			return false;
		}
	});
	const pipeline = (db: Database) =>
		deps.capabilities
			.toolchainsInTransaction(db)
			.find(
				(card) =>
					card.id === "pipeline.execute" &&
					!!execution.pipelineInTransaction?.(db, card.revisionId),
			);
	const catalog = (db: Database, source: Source) =>
		execution.pipelineCatalogInTransaction?.(db, source) ?? [];
	const browser = () => {
		if (!interact) throw new Error("collaboration_unavailable");
		return interact;
	};
	return {
		report: (db, sessionId, childId) =>
			dialogue.specialistResultTextInTransaction(db, sessionId, childId),
		source: (db, runId) =>
			dialogue.specialistExecutionSourceInTransaction(db, runId),
		authority: dialogue.specialistAuthorityInTransaction,
		available: (db, kind) =>
			kind === "pipeline"
				? !!pipeline(db) &&
					agents.executions.pipelinesAvailableInTransaction(db)
				: !!interact && deps.interactAvailable(db),
		context(db, kind, source) {
			return kind === "pipeline"
				? {
						contractVersion: "p0-3",
						cards: catalog(db, source).map((record) => record.card),
					}
				: { available: deps.interactAvailable(db) };
		},
		check(db, kind, value, source) {
			if (kind === "interact") {
				const parsed = z
					.strictObject({ startUrl: z.url().max(2048) })
					.safeParse(value);
				return parsed.success
					? { ok: true, value: parsed.data }
					: { ok: false, issues: [{ path: "startUrl", rule: "url_required" }] };
			}
			const checked = checkPipelineDefinition(
				value,
				catalog(db, source),
				source.request,
			);
			return checked.ok
				? { ok: true, value: checked.definition }
				: {
						ok: false,
						issues: checked.issues.map((issue) => ({
							path: issue.path,
							rule: issue.code,
						})),
					};
		},
		start(db, kind, input) {
			const source = sourceWithHistory(input.source, input.history);
			if (
				!withinJsonLimits(source) ||
				!execution.validSourceInTransaction(db, source)
			)
				throw new Error("execution_source_invalid");
			if (kind === "pipeline") {
				const card = pipeline(db);
				if (!card) throw new Error("pipeline_unavailable");
				return pipelineView(
					agents.executions.startPipelineInTransaction(db, {
						source,
						toolchainRevisionId: card.revisionId,
						definition: input.value,
						requestId: input.requestId,
					}),
				);
			}
			if (!deps.interactAvailable(db))
				throw new Error("collaboration_unavailable");
			const { startUrl } = z
				.strictObject({ startUrl: z.url().max(2048) })
				.parse(input.value);
			return interactView(
				browser().startInTransaction(
					db,
					owner,
					input.requestId,
					{
						request: source.request,
						startUrl,
						conversationId: source.conversationId,
					},
					{
						source: { kind: "collaboration", source },
						executionId: input.workRef,
					},
				),
			);
		},
		view(db, kind, source, id) {
			if (kind === "interact")
				return interactView(
					browser().statusInTransaction(db, owner, source.conversationId, id),
				);
			const view = agents.executions.viewInTransaction(db, id);
			return view?.conversationId === source.conversationId
				? pipelineView(view)
				: null;
		},
		answer(db, kind, source, response, child, input, history) {
			if (!child.question) throw new Error("collaboration_question_closed");
			if (kind === "pipeline")
				return pipelineView(
					agents.executions.controlInTransaction(
						db,
						source.conversationId,
						{
							workRef: child.id,
							expectedRevision: child.revision,
							action: "answer",
							questionRef: child.question.id,
							input,
						},
						response.messageId,
					),
				);
			const value = child.question.approval
				? z.strictObject({ approved: z.boolean() }).parse(input)
				: z
						.strictObject({ text: z.string().trim().min(1).max(4000) })
						.parse(input);
			return interactView(
				browser().answerInTransaction(
					db,
					owner,
					{
						...value,
						runId: child.id,
						conversationId: source.conversationId,
						questionId: child.question.id,
						generation: child.question.generation,
						expectedRevision: child.revision,
					},
					{ kind: "collaboration", source: sourceWithHistory(source, history) },
				),
			);
		},
		forget(db, kind, source, workRef) {
			if (source.specialistSessionId)
				dialogue.forgetSpecialistObservationsInTransaction(
					db,
					source.specialistSessionId,
				);
			if (kind === "interact")
				browser().purgeExecutionInTransaction(db, workRef);
			else if (kind === "pipeline")
				agents.executions.purgeSourcesInTransaction(db, {
					messageIds: [source.messageId],
					itemIds: [],
				});
		},
		cancel(db, kind, source, id) {
			if (kind === "pipeline") {
				agents.executions.cancelByUserInTransaction(
					db,
					source.conversationId,
					id,
				);
				return;
			}
			browser().cancelInTransaction(db, owner, source.conversationId, id);
		},
		notify: dialogue.notifySpecialistInTransaction,
	};
}
