import { liveSession } from "../repository/specialist";
import type { Database } from "bun:sqlite";
import { parseLlmJson } from "../../../infrastructure/llm-json";
import { executionCallSession, type ChildExecution } from "../../tool-runtime";
import type { BoundCommandSet } from "../contracts/toolchains";
import { byId } from "../repository";
import type { DialogueDeps } from "./context";
import { commandSource } from "./command-source";
import {
	commandPrompt,
	commandOutputFor,
	parseToolCommand,
} from "./toolchain-command";
import type { BoundInvocation } from "./command-apply";
import { executionSourceInTransaction } from "./execution-source";
import type { DelegationCommand } from "../contracts/delegation";

/** The existing command translator, with a real source turn and a separate child-call identity. */
export function executionCommands(deps: DialogueDeps) {
	function prepareInTransaction(db: Database, child: ChildExecution) {
		const run = byId(db, child.source.runId);
		const source = executionSourceInTransaction(deps, db, child.source.runId);
		if (
			!run ||
			source?.digest !== child.source.digest ||
			!deps.toolchains?.bound ||
			!deps.larm.captureUserControlInTransaction
		)
			throw new Error("execution_source_invalid");
		const set = deps.toolchains.commandSetInTransaction(
			db,
			child.chainRevisionId,
		);
		const loaded = commandSource(
			deps,
			db,
			run,
			set,
			{ toolchainRevisionId: child.chainRevisionId },
			child,
		);
		if (!loaded.ok) throw new Error(loaded.code);
		const { snapshot, tools, toolIds } = loaded.source;
		const questionRefs =
			set.binding?.questions.map((q) => q.inputSchemaRef) ?? [];
		const prompt = commandPrompt(
			set,
			tools,
			{
				executionStep: true,
				execution: {
					sourceRunId: child.source.runId,
					id: child.executionId,
					callId: child.id,
				},
				originalRequest: child.source.request,
				requestUpdates: child.source.amendments,
				userAnswers: child.source.responses,
				snapshot,
				references: child.referenceData ?? child.refs,
				...(child.materials?.length ? { materials: child.materials } : {}),
				...(child.resume
					? {
							previousQuestion: child.resume.previous,
							answer: child.resume.input,
						}
					: {}),
				request: child.request,
			},
			questionRefs,

			Date.parse(deps.clock()),
		);
		const requestId = deps.larm.captureUserControlInTransaction(db, {
			subject: `execution-command:${child.id}-${child.resume?.questionId ?? "initial"}`,
			deadline: Math.min(child.deadline, Date.now() + 45_000),
			maxOutputTokens: 2048,
		});
		return {
			requestId,
			...prompt,
			backend: set.backend,
			toolIds,
			snapshot,
			boundSet: set.binding,
			questionRefs,
			questionDetails: Object.fromEntries(
				questionRefs.map((ref) => [
					ref,
					{
						...deps.toolchains!.bound?.answerSchema?.(ref),
						"x-choices": set.binding
							? deps.toolchains!.bound?.questionChoicesInTransaction(
									db,
									set.binding.bindingRevisionId,
									ref,
								)
							: [],
					},
				]),
			),
		};
	}
	async function execute(
		input: ReturnType<typeof prepareInTransaction>,
		child: ChildExecution,
		signal: AbortSignal,
	) {
		const receipt = await deps.larm.executeControl!(
			input.requestId,
			input.messages,
			signal,
			input.control,
			executionCallSession(child),
		).finally(() => deps.larm.releaseTaskSession?.(child.id));
		const out = commandOutputFor(input.questionRefs).parse(
			parseLlmJson(receipt.value),
		);
		if (out.action === "clarify") {
			if (!out.question) throw new Error("toolchain_command_invalid_contract");
			return {
				receipt,
				question: out.question,
				answerSchema: out.answerSchema ?? "builtin:answerText",
				questionSchema: out.answerSchema
					? input.questionDetails[out.answerSchema]
					: undefined,
			};
		}
		if (input.boundSet) {
			const parsed = deps.toolchains!.bound!.parseInvocation(
				input.boundSet,
				out.tool ?? "",
				out.arguments,
			);
			if (!parsed.ok) throw new Error(parsed.code);
			const invocation: BoundInvocation = {
				bindingRevisionId: input.boundSet.bindingRevisionId,
				adapterRef: input.boundSet.adapterRef,
				packageRevisionId: input.boundSet.packageRevisionId,
				toolRevisionId: parsed.toolRevisionId,
				operationName: parsed.operationName,
				input: parsed.input,
			};
			return { receipt, invocation };
		}
		return { receipt, command: parseToolCommand(input, out) };
	}
	return {
		prepareInTransaction,
		execute,
		sessionAvailableInTransaction: () => !!deps.specialist,
		sessionHandoffInTransaction(db: Database, child: ChildExecution) {
			if (!deps.specialist) throw new Error("capability_unavailable");
			const set = deps.specialist.setInTransaction(db, child.chainRevisionId);
			const session = liveSession(db, child.source.conversationId);
			const work = session
				? deps.specialist.workStateInTransaction(
						db,
						session.adapterRef,
						session.workRef,
					)
				: null;
			return {
				chainRevisionId: child.chainRevisionId,
				adapterRef: set.adapterRef,
				artifactRevisionId: set.artifactRevisionId,
				targets: deps.specialist.targetChoicesInTransaction(db, set),
				existingWork: work
					? {
							workRef: work.workRef,
							dirty: work.dirty,
							busy: work.busy,
							revision: work.revision,
							label: work.label,
						}
					: null,
				requiresUnsavedConfirmation: work?.dirty === true,
			};
		},
		legacyAvailableInTransaction(
			db: Database,
			kind: "object-recognition" | "dots",
			runId: string,
		) {
			const run = byId(db, runId);
			return kind === "object-recognition"
				? !!deps.objectRecognition
				: !!run && !!deps.delegation?.prepareInTransaction(db, run).available;
		},
		invokeLegacyInTransaction(
			db: Database,
			child: ChildExecution,
			input: ReturnType<typeof prepareInTransaction>,
			command: unknown,
		) {
			const run = byId(db, child.source.runId);
			if (!run || !executionSourceInTransaction(deps, db, run.id))
				throw new Error("execution_source_invalid");
			const callId = child.dispatchId ?? child.id;
			if (input.backend === "object-recognition" && deps.objectRecognition) {
				deps.objectRecognition.invokeInTransaction(
					db,
					run.id,
					run.conversationId,
					command,
					{
						inputImages:
							deps.conversation.messageInTransaction(db, run.inputMessageId)
								?.message.attachments?.length ?? 0,
						callId,
					},
				);
				return deps.objectRecognition.resultForCallInTransaction?.(db, callId);
			}
			if (input.backend === "dots" && deps.delegation)
				return deps.delegation.invokeInTransaction(
					db,
					run,
					command as DelegationCommand,
					input.snapshot,
					{ callId, deadline: child.deadline },
				);
			throw new Error("adapter_unavailable");
		},
		legacyTaskInTransaction: (
			db: Database,
			conversationId: string,
			taskId: string,
		) =>
			deps.delegation?.executionTaskInTransaction?.(db, conversationId, taskId),
		cancelLegacyTaskInTransaction: (
			db: Database,
			conversationId: string,
			taskId: string,
		) =>
			deps.delegation?.cancelExecutionTaskInTransaction?.(
				db,
				conversationId,
				taskId,
			),
		validateAnswer(
			set: BoundCommandSet | undefined,
			schema: string,
			input: unknown,
		) {
			if (schema === "builtin:answerText")
				return (
					typeof input === "string" &&
					input.trim().length > 0 &&
					input.length <= 8000
				);
			return (
				!!set?.questions.some((q) => q.inputSchemaRef === schema) &&
				!!deps.toolchains?.bound?.parseAnswer(schema, input).ok
			);
		},
	};
}
