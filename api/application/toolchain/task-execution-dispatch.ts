import type { Database } from "bun:sqlite";
import { taskAutonomy } from "./task-autonomy";
import { isStandardExecutionSource } from "../../domains/tool-runtime";
import type { ToolchainRoutingPort } from "../../domains/dialogue";
import type { DialogueService } from "../../domains/dialogue";
import type {
	ChildExecution,
	ChildResult,
	ToolchainExecutionPort,
} from "../../domains/tool-runtime";
import type { TaskChildContext } from "./task-execution-catalog";
import type { TaskExecutionHost } from "./task-execution-port";
import { result, total } from "./task-execution-values";

type CommandInput = ReturnType<
	DialogueService["executionCommands"]["prepareInTransaction"]
>;
type DeferredCommand = {
	kind: "deferred_command";
	bindingRevisionId: string;
	prepare(signal: AbortSignal): Promise<void>;
};

export function taskExecutionDispatch(
	host: TaskExecutionHost,
	context: TaskChildContext,
	readReference: ToolchainExecutionPort["readReferenceInTransaction"],
): Pick<ToolchainExecutionPort, "prepareInTransaction" | "execute"> {
	const { store, capabilities, agents, routing, dialogue, inference } = host;
	const { resolve, live, research, bound } = context;
	function withReferenceData(db: Database, child: ChildExecution) {
		const input = {
			...child,
			referenceData: child.refs.map((ref) => ({
				ref: ref.ref,
				text: readReference(db, child.source, ref, 0, 2000),
			})),
		};
		if (new TextEncoder().encode(JSON.stringify(input)).length > 24_576)
			throw new Error("execution_input_capacity");
		return input;
	}
	const commandInput = (db: Database, child: ChildExecution) =>
		dialogue.executionCommands.prepareInTransaction(
			db,
			child,
			child.source.origin === "autonomous"
				? taskAutonomy(host, context)(db, child.chainRevisionId).operations
				: undefined,
		);
	async function prepareDeferredCommand(
		prepared: DeferredCommand,
		child: ChildExecution,
		signal: AbortSignal,
	) {
		const check = (db: Database) => {
			signal.throwIfAborted();
			live(db, child);
			const current = capabilities.toolchainBindingInTransaction(
				db,
				child.chainRevisionId,
			);
			if (current?.binding.revisionId !== prepared.bindingRevisionId)
				throw new Error("toolchain_unavailable");
		};
		store.read(check);
		await prepared.prepare(signal);
		return store.write((db) => {
			check(db);
			return commandInput(db, withReferenceData(db, child));
		});
	}
	return {
		prepareInTransaction(db, child) {
			if (!isStandardExecutionSource(child.source))
				throw new Error("execution_source_invalid");
			live(db, child);
			if (child.source.origin === "workflow")
				return host.workflowSteps!.prepare(db, child);
			child = withReferenceData(db, child);
			const resolved = resolve(db, child);
			const { execution: kind, binding } = resolved.runtime;
			if (kind === "command") {
				const adapter = binding && host.registry.get(binding.adapterRef);
				const prepare = adapter?.commandPreparationInTransaction?.(db);
				if (binding && prepare)
					return {
						kind: "deferred_command",
						bindingRevisionId: binding.bindingRevisionId,
						prepare,
					} satisfies DeferredCommand;
				return { kind, input: commandInput(db, child) } as const;
			}
			if (kind === "instant") {
				const parsed = routing
					.cardInTransaction(db, child.chainRevisionId)
					?.instant?.parse(child.arguments ?? {});
				if (!parsed?.ok) throw new Error("invalid_input");
				return {
					kind,
					run: routing.instantInTransaction?.(db, child.chainRevisionId),
					arguments: parsed.value,
				} as const;
			}
			if (
				kind === "research" ||
				(kind === "task" &&
					child.selectedWorker &&
					routing.taskInTransaction?.(db, child.chainRevisionId)
						?.selectedWorker)
			) {
				agents.startInTransaction(db, {
					rootRunId: child.source.runId,
					deadline: child.deadline,
					execution: child,
					input: {
						kind:
							kind === "task" ? "registered_worker" : resolved.runtime.route,
						question: child.request,
						originalRequest: child.source.request,
						packageRevisionId: resolved.packageRevisionId,
					},
				});
				return { kind: "research", result: research(db, child) } as const;
			}
			if (kind === "session")
				return {
					kind,
					result: result(
						"handoff",
						{
							kind: "session",
							...dialogue.executionCommands.sessionHandoffInTransaction(
								db,
								child,
							),
							chainRevisionId: child.chainRevisionId,
							request: child.request,
						},
						"対話を伴う制作は会話側から担当へ引き継ぐ必要があります。",
						total(child, 0),
						"interactive_handoff",
					),
				} as const;
			if (kind === "task" || kind === "pipeline")
				throw new Error("recursive_execution_denied");
			// A read tool is the conversation's own, never a step of a task.
			if (kind === "read") throw new Error("capability_unavailable");
			if (!host.media) throw new Error("capability_unavailable");
			return {
				kind: "media",
				result: host.media.startInTransaction(db, child, kind),
			} as const;
		},
		async execute(raw, child, signal) {
			if (!isStandardExecutionSource(child.source))
				throw new Error("execution_source_invalid");
			if (child.source.origin === "workflow") {
				store.read((db) => live(db, child));
				signal.throwIfAborted();
				return host.workflowSteps!.execute(raw, signal);
			}
			const prepared = raw as
				| { kind: "command"; input: CommandInput }
				| DeferredCommand
				| {
						kind: "instant";
						arguments: Record<string, unknown>;
						run: ReturnType<
							NonNullable<ToolchainRoutingPort["instantInTransaction"]>
						>;
				  }
				| { kind: "research" | "media" | "session"; result: ChildResult };
			if (prepared.kind === "instant") {
				const answer = await prepared.run?.run(prepared.arguments, signal, {
					conversationId: child.source.conversationId,
					assertCurrent: () => store.read((db) => live(db, child)),
				});
				if (answer?.ok)
					return result(
						"completed",
						{ kind: "instant" },
						answer.answer,
						total(child, 0),
					);
				if (!prepared.run?.fallback)
					return result(
						"failed",
						{ kind: "instant" },
						answer && !answer.ok ? answer.code : "instant_unavailable",
						total(child, 0),
					);
				return store.write((db) => {
					live(db, child);
					if (
						child.source.origin === "autonomous" &&
						!taskAutonomy(host, context)(db, prepared.run!.fallback!.revisionId)
							.automatic
					)
						throw new Error("agency_approval_required");
					const target = routing.resolveInTransaction(
						db,
						prepared.run!.fallback!.revisionId,
					);
					agents.startInTransaction(db, {
						rootRunId: child.source.runId,
						deadline: child.deadline,
						execution: child,
						input: {
							kind: target.runtime.route,
							question: child.request,
							originalRequest: child.source.request,
							packageRevisionId: target.packageRevisionId,
						},
					});
					return research(db, child);
				});
			}
			if (prepared.kind !== "command" && prepared.kind !== "deferred_command")
				return prepared.result;
			const input =
				prepared.kind === "deferred_command"
					? await prepareDeferredCommand(prepared, child, signal)
					: prepared.input;
			signal.throwIfAborted();
			const translated = await dialogue.executionCommands.execute(
				input,
				child,
				signal,
			);
			return store.write((db) => {
				live(db, child);
				signal.throwIfAborted();
				if (!inference.acceptInTransaction?.(db, translated.receipt))
					throw new Error("permission_revoked");
				if (translated.question)
					return {
						...result(
							"waiting_input",
							{ kind: "question", answerSchema: translated.answerSchema },
							translated.question,
							total(child, 1),
						),
						question: translated.question,
						questionSchema: translated.questionSchema,
					};
				if (!translated.invocation) {
					if (!host.legacy) throw new Error("adapter_unavailable");
					return host.legacy.invokeInTransaction(
						db,
						child,
						input,
						translated.command,
					);
				}
				const command = translated.invocation;
				if (child.source.origin === "autonomous") {
					const policy = host.registry
						.get(command.adapterRef)
						?.describe()
						.operations.get(command.operationName);
					if (policy?.effect !== "read" && policy?.autonomy !== "create")
						throw new Error("agency_approval_required");
				}
				const actionCapability = capabilities.prepareBoundInTransaction(
					db,
					{
						rootRunId: child.source.runId,
						taskId: child.id,
						cancelEpoch: child.revision,
					},
					command.packageRevisionId,
					command.toolRevisionId,
					command.input,
				);
				agents.startInTransaction(db, {
					rootRunId: child.source.runId,
					deadline: child.deadline,
					execution: { ...child, modelCalls: child.modelCalls - 1 },
					actionCapability,
					input: {
						kind: "action",
						question: child.request,
						originalRequest: child.source.request,
						command,
					},
				});
				const accepted = agents.executionChildInTransaction(
					db,
					child.dispatchId ?? child.id,
				);
				if (!accepted?.action)
					return result(
						"failed",
						{ kind: "bound" },
						accepted?.root.error_code ?? "operation_rejected",
						total(child, 1),
					);
				const ref = {
					kind: "bound",
					dispatchId: child.dispatchId ?? child.id,
					adapterRef: command.adapterRef,
					operationId: accepted.action.operation_id,
					calls: 1,
				};
				if (accepted.ticket)
					agents.adoptExecutionChildInTransaction(
						db,
						child.dispatchId ?? child.id,
					);
				return bound(db, child, ref);
			});
		},
	};
}
