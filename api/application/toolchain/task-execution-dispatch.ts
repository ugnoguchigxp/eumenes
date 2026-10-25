import type { ToolchainRoutingPort } from "../../domains/dialogue";
import type { DialogueService } from "../../domains/dialogue";
import type {
	ChildResult,
	ToolchainExecutionPort,
} from "../../domains/tool-runtime";
import type { TaskChildContext } from "./task-execution-catalog";
import type { TaskExecutionHost } from "./task-execution-port";
import { result, total } from "./task-execution-values";
export function taskExecutionDispatch(
	host: TaskExecutionHost,
	context: TaskChildContext,
	readReference: ToolchainExecutionPort["readReferenceInTransaction"],
): Pick<ToolchainExecutionPort, "prepareInTransaction" | "execute"> {
	const { store, capabilities, agents, routing, dialogue, inference } = host;
	const { resolve, live, research, bound } = context;
	const port: Pick<
		ToolchainExecutionPort,
		"prepareInTransaction" | "execute" | "readReferenceInTransaction"
	> = {
		readReferenceInTransaction: readReference,
		prepareInTransaction(db, child) {
			live(db, child);
			child = {
				...child,
				referenceData: child.refs.map((ref) => ({
					ref: ref.ref,
					text: port.readReferenceInTransaction(db, child.source, ref, 0, 2000),
				})),
			};
			if (new TextEncoder().encode(JSON.stringify(child)).length > 24_576)
				throw new Error("execution_input_capacity");
			const resolved = resolve(db, child);
			const kind = resolved.runtime.execution;
			if (kind === "command")
				return {
					kind,
					input: dialogue.executionCommands.prepareInTransaction(db, child),
				} as const;
			if (kind === "instant")
				return {
					kind,
					run: routing.instantInTransaction?.(db, child.chainRevisionId),
				} as const;
			if (kind === "research") {
				agents.startInTransaction(db, {
					rootRunId: child.source.runId,
					deadline: child.deadline,
					execution: child,
					input: {
						kind: resolved.runtime.route,
						question: child.request,
						originalRequest: child.source.request,
						packageRevisionId: resolved.packageRevisionId,
					},
				});
				return { kind, result: research(db, child) } as const;
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
			if (!host.media) throw new Error("capability_unavailable");
			return {
				kind: "media",
				result: host.media.startInTransaction(db, child, kind),
			} as const;
		},
		async execute(raw, child, signal) {
			const prepared = raw as ReturnType<typeof port.prepareInTransaction> &
				(
					| {
							kind: "command";
							input: ReturnType<
								DialogueService["executionCommands"]["prepareInTransaction"]
							>;
					  }
					| {
							kind: "instant";
							run: ReturnType<
								NonNullable<ToolchainRoutingPort["instantInTransaction"]>
							>;
					  }
					| { kind: "research" | "media" | "session"; result: ChildResult }
				);
			if (prepared.kind === "instant") {
				const answer = await prepared.run?.run(child.arguments ?? {}, signal);
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
			if (prepared.kind !== "command") return prepared.result;
			const translated = await dialogue.executionCommands.execute(
				prepared.input,
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
						prepared.input,
						translated.command,
					);
				}
				const command = translated.invocation;
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
	return {
		prepareInTransaction: port.prepareInTransaction,
		execute: port.execute,
	};
}
