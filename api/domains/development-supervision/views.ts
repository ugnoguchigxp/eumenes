import type { ExecutionResult, ExecutionView } from "../tool-runtime";
import type { SupervisedRow } from "./contracts";
import type { Parent, Task } from "./state";

export function rows(parent: Parent): SupervisedRow[] {
	return parent.tasks.map((task) => {
		const base = {
			parentId: parent.id,
			conversationId: parent.source.conversationId,
			workspaceRef: parent.workspace.workspaceRef,
			taskId: task.id,
			title: task.proposal.title,
			revision: task.revision,
			parentRevision: parent.revision,
			designRevision: task.designRevision,
			reason: task.reason,
			...(task.blockerRef ? { blockerRef: task.blockerRef } : {}),
			result: task.result,
			evidenceRefs: [...task.readEvidence, ...task.evidence].map(
				({ ref }) => ref,
			),
		};
		if (task.state === "finished" && task.outcome)
			return {
				...base,
				state: task.state,
				column: "finished",
				outcome: task.outcome,
			};
		if (task.state === "held" || task.state === "running")
			return { ...base, state: task.state, column: "running" };
		return { ...base, state: "waiting", column: "todo" };
	});
}

export function executionView(parent: Parent): ExecutionView {
	const summary = parent.tasks
		.map(({ proposal, reason }) => `${proposal.title} · ${reason}`)
		.join("\n");
	const latest = parent.designs.findLast(
		({ documentId, generation }) =>
			generation === parent.generation && parent.designUris[documentId],
	);
	const design = latest && parent.designUris[latest.documentId];
	return {
		id: parent.id,
		conversationId: parent.source.conversationId,
		request: parent.request,
		revision: parent.revision,
		status:
			parent.result?.status ??
			(parent.question
				? "waiting_user"
				: parent.stop
					? "stopping"
					: parent.phase === "active"
						? "waiting_child"
						: parent.phase === "plan"
							? "deciding"
							: "queued"),
		deadline: parent.deadline,
		result: parent.result,
		question: parent.question,
		tasks: rows(parent),
		conversationSummary: parent.conversationSummary,
		progress: {
			summary:
				(summary || parent.reason).slice(0, 1_750) +
				(design ? `\n[設計書](${design})` : ""),
			observedAt: parent.observedAt,
		},
	};
}

export function progressOf(parent: Parent) {
	return {
		parentId: parent.id,
		revision: parent.revision,
		state: executionView(parent).status,
		reason: parent.result?.summary ?? parent.question?.prompt ?? parent.reason,
		result: parent.result,
		question: parent.question,
		designs: parent.designs
			.filter(({ generation }) => generation === parent.generation)
			.map(({ revision, documentId, digest }) => ({
				revision,
				documentId,
				digest,
				...(parent.designUris[documentId]
					? { uri: parent.designUris[documentId] }
					: {}),
			})),
		tasks: rows(parent),
	};
}

export function result(
	status: ExecutionResult["status"],
	summary: string,
	refs: string[] = [],
	missing: string[] = [],
): ExecutionResult {
	return {
		status,
		summary: summary.slice(0, 2_000),
		refs: [...new Set(refs)],
		missing,
		fulfilled: [],
	};
}

export function finishTask(
	task: Task,
	status: ExecutionResult["status"],
	reason: string,
	refs: string[] = [],
) {
	task.phase = "finished";
	task.state = "finished";
	task.reason = reason;
	task.outcome =
		status === "completed"
			? "succeeded"
			: status === "partial"
				? "partial"
				: status === "cancelled"
					? "cancelled"
					: status === "interrupted"
						? "interrupted"
						: "failed";
	task.jobId = null;
	task.result = result(status, reason, refs);
	delete task.blockerRef;
}
