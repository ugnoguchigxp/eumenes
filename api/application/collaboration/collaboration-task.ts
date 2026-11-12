import type { Database } from "bun:sqlite";
import {
	collaborationInputs,
	type ToolchainCard,
} from "../../domains/capabilities";
import type { Ports, Source } from "../../domains/collaboration";
import type { ToolchainExecutionPort } from "../../domains/tool-runtime";
import type { TaskExecutionHost } from "../toolchain/task-execution-port";
import { executionChildView } from "./collaboration-backends";

export const collaborationTaskId = "collaboration.task";

export function collaborationTask(
	host: Pick<TaskExecutionHost, "agents" | "dialogue">,
	execution: ToolchainExecutionPort,
) {
	const { agents, dialogue } = host;
	const refs = (db: Database, source: Source) =>
		[
			...new Map(
				[
					...dialogue.specialistHandoffReferencesInTransaction(
						db,
						source.specialistSessionId!,
					),
					...agents.executions.contextReferencesInTransaction(
						db,
						source.conversationId,
					),
				]
					.filter((ref) =>
						execution.validReferenceInTransaction(db, source, ref),
					)
					.map((ref) => [ref.ref, ref]),
			).values(),
		].slice(0, 32);
	const forContinuation = (db: Database, source: Source, id: string) =>
		agents.executions.continuationInTransaction(db, source.conversationId, id);
	const view = (db: Database, source: Source, id: string) => {
		const current = agents.executions.continuationInTransaction(
			db,
			source.conversationId,
			id,
			source.specialistSessionId,
		);
		return current ? executionChildView(current) : null;
	};
	const allowed = (card: ToolchainCard) =>
		card.id !== collaborationTaskId && card.execution !== "read";
	return {
		handoff(db: Database, revisionId: string) {
			const card = execution.cardInTransaction(db, revisionId);
			return (
				!!card &&
				allowed(card) &&
				card.execution === "session" &&
				card.minImpact !== "modify_existing" &&
				card.minImpact !== "irreversible"
			);
		},
		view,
		continuation(db: Database, source: Source, id: string) {
			if (
				!agents.executions
					.listInTransaction(db, source.conversationId)
					.some((run) => run.id === id)
			)
				return null;
			const current = forContinuation(db, source, id);
			return current ? executionChildView(current) : null;
		},
		context(db: Database, source: Source) {
			const runs = agents.executions
				.listInTransaction(db, source.conversationId)
				.flatMap(({ id }) => {
					const run = forContinuation(db, source, id);
					return run
						? [
								{
									...executionChildView(run),
									request: run.request.slice(0, 1000),
								},
							]
						: [];
				});
			return {
				runs,
				references: refs(db, source).map(({ ref, label, kind }) => ({
					ref,
					label,
					kind,
				})),
			};
		},
		async find(query: string, source: Source, signal: AbortSignal) {
			const cards = await execution.find(query, source, signal, {
				lexicalFallback: true,
			});
			return cards.filter(allowed).map((card) => ({
				id: card.id,
				revisionId: card.revisionId,
				title: card.title,
				summary: card.summary,
				execution: card.execution,
				minImpact: card.minImpact,
				...(card.instant ? { arguments: card.instant.parameters } : {}),
			}));
		},
		start(db: Database, input: Parameters<Ports["start"]>[2]) {
			const args = collaborationInputs.collaborationTaskStart
				.omit({ expectedRevision: true })
				.parse(input.value);
			const card = execution.cardInTransaction(db, args.revisionId);
			if (!card || !allowed(card)) throw new Error("toolchain_unavailable");
			if (
				card.execution === "session" ||
				card.minImpact === "modify_existing" ||
				card.minImpact === "irreversible"
			)
				throw new Error("collaboration_handoff_required");
			const issued = new Map(
				refs(db, input.response).map((ref) => [ref.ref, ref]),
			);
			const references = (args.refs ?? []).map((key) => {
				const ref = issued.get(key);
				if (!ref) throw new Error("execution_reference_invalid");
				return ref;
			});
			return executionChildView(
				agents.executions.startSelectedInTransaction(db, {
					source: input.response,
					chainRevisionId: card.revisionId,
					request: args.request,
					arguments: args.arguments,
					references,
					deadline: Date.now() + 180_000,
				}),
			);
		},
		answer(
			db: Database,
			response: Source,
			child: import("../../domains/collaboration").ChildView,
			input: unknown,
		) {
			return executionChildView(
				agents.executions.controlInTransaction(
					db,
					response.conversationId,
					{
						workRef: child.id,
						expectedRevision: child.revision,
						action: "answer",
						questionRef: child.question!.id,
						input,
					},
					response.messageId,
					response,
				),
			);
		},
		amend(
			db: Database,
			response: Source,
			childId: string,
			revision: number,
			request: string,
		) {
			return executionChildView(
				agents.executions.controlInTransaction(
					db,
					response.conversationId,
					{
						workRef: childId,
						expectedRevision: revision,
						action: "amend",
						request,
					},
					response.messageId,
					response,
				),
			);
		},
	};
}
