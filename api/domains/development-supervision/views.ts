import type { ExecutionResult, ExecutionView } from "../tool-runtime";
import type { GoalSupervisionReceipt, SupervisedRow } from "./contracts";
import type { Parent, Task } from "./state";

export function rows(parent: Parent): SupervisedRow[] {
	if (parent.source.origin === "goal") return [];
	const conversationId = parent.source.conversationId;
	return parent.tasks.map((task) => {
		const base = {
			parentId: parent.id,
			conversationId,
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
	if (parent.source.origin === "goal")
		throw new Error("supervision_owner_mismatch");
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
		status: statusOf(parent),
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

function statusOf(parent: Parent): ExecutionView["status"] {
	if (parent.result) return parent.result.status;
	if (parent.question) return "waiting_user";
	if (parent.stop) return "stopping";
	if (parent.phase === "active") return "waiting_child";
	if (parent.phase === "plan") return "deciding";
	return "queued";
}

export function goalReceipt(parent: Parent): GoalSupervisionReceipt {
	if (parent.source.origin !== "goal")
		throw new Error("supervision_owner_mismatch");
	return {
		ownerWorkId: parent.id,
		ownerRevision: parent.revision,
		status: statusOf(parent),
		result: parent.result,
		question: parent.question,
		questionReleased: parent.goalQuestionReleased === true,
		evidence: parent.tasks.flatMap(({ readEvidence, evidence }) => [
			...readEvidence,
			...evidence,
		]),
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
