import { hash } from "../../domains/capabilities";
import type { ToolchainExecutionPort } from "../../domains/tool-runtime";
import type { TaskChildContext } from "./task-execution-catalog";
import type { TaskExecutionHost } from "./task-execution-port";
import { reference } from "./task-execution-values";
export function taskExecutionSources(
	host: TaskExecutionHost,
	context: TaskChildContext,
): Pick<
	ToolchainExecutionPort,
	| "validSourceInTransaction"
	| "controlSourceInTransaction"
	| "validReferenceInTransaction"
	| "readReferenceInTransaction"
> {
	const { agents, dialogue, conversation, memory, resources } = host;
	const { resolve, bound } = context;
	const checkingReferences = new Set<string>();
	const port: ReturnType<typeof taskExecutionSources> = {
		validSourceInTransaction(db, source) {
			const current = dialogue.executionSourceInTransaction(db, source.runId);
			const { amendments, responses, ...original } = source;
			return (
				!!current &&
				hash(current) === hash(original) &&
				![...(amendments ?? []), ...(responses ?? [])].some((update) => {
					const control = port.controlSourceInTransaction(
						db,
						source.conversationId,
						update.messageId,
					);
					return !control || hash(control) !== hash(update);
				})
			);
		},
		controlSourceInTransaction(db, conversationId, messageId) {
			const message = conversation.messageInTransaction(db, messageId)?.message;
			if (!message?.runId || message.conversationId !== conversationId)
				return null;
			const source = dialogue.executionSourceInTransaction(db, message.runId);
			return source
				? {
						messageId: source.messageId,
						request: source.request,
						digest: source.digest,
					}
				: null;
		},
		validReferenceInTransaction(db, source, ref) {
			if (checkingReferences.has(ref.ref) || checkingReferences.size >= 32)
				return false;
			checkingReferences.add(ref.ref);
			try {
				// A resource still resolves, and its preview is the one the conversation handed over.
				if (ref.kind === "resource")
					return (
						!!resources?.resolveInTransaction(db, ref.ref).ok &&
						hash(ref.preview) === ref.digest
					);
				if (ref.owner === "conversation") {
					const message = conversation.messageInTransaction(
						db,
						ref.id,
					)?.message;
					return (
						!!message &&
						message.conversationId === source.conversationId &&
						hash(message.text) === ref.digest &&
						!memory
							?.blockedMessageIdsOfConversationInTransaction(
								db,
								source.conversationId,
							)
							.includes(ref.id)
					);
				}
				if (ref.owner === "memory")
					return (
						memory?.executionReferenceInTransaction(db, ref) !== null &&
						!!memory
					);
				if (ref.owner !== "agent-runtime") return false;
				const stored = agents.executions.resultReferenceInTransaction(
					db,
					source.conversationId,
					ref,
				);
				if (!stored) return false;
				if (
					!port.validSourceInTransaction(db, stored.child.source) ||
					stored.child.refs.some(
						(ancestor) =>
							!port.validReferenceInTransaction(
								db,
								stored.child.source,
								ancestor,
							),
					)
				)
					return false;
				try {
					resolve(db, stored.child);
					const r = reference.parse(stored.result.ref);
					if (r.kind === "research" && r.reportDigest)
						return agents.validateExecutionReportInTransaction(
							db,
							r.dispatchId!,
							r.reportDigest,
						);
					if (r.kind === "bound")
						return bound(db, stored.child, r).state === stored.result.state;
					return (
						stored.result.state === "completed" ||
						stored.result.state === "failed"
					);
				} catch {
					return false;
				}
			} finally {
				checkingReferences.delete(ref.ref);
			}
		},
		readReferenceInTransaction(db, source, ref, start, limit) {
			if (!port.validReferenceInTransaction(db, source, ref))
				throw new Error("execution_reference_invalid");
			const body =
				ref.kind === "resource"
					? ref.preview
					: ref.owner === "conversation"
						? conversation.messageInTransaction(db, ref.id)!.message.text
						: ref.owner === "memory"
							? memory!.executionReferenceInTransaction(db, ref)!
							: JSON.stringify(
									agents.executions.resultReferenceInTransaction(
										db,
										source.conversationId,
										ref,
									)!.result,
								);
			return [...body].slice(start, start + Math.min(limit, 2000)).join("");
		},
	};
	return port;
}
