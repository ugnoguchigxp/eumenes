import type { Database } from "bun:sqlite";
import type {
	GoalProgress,
	GoalQuestion,
	GoalStore,
} from "eumenes-agency/agenda/runtime";
import { canResolveGoalQuestion } from "eumenes-agency/agenda/runtime";
import type { ConversationService } from "../../domains/conversation";
import type { MemoryService } from "../../domains/memory";
import { captureGoalSources } from "./goal-input-sources";
import { goalAccess, goalDigest } from "./goal-progress-context";
import type { AgencyRecordInputDeps } from "./input";

export function goalQuestionMessageId(row: GoalProgress, ref: string) {
	return `agency-goal-question:${goalDigest([row.principal, row.goalId, row.goalRevision, ref])}`;
}

export interface GoalQuestionDeliveryPorts {
	goals: GoalStore;
	conversation: Pick<
		ConversationService,
		"appendInTransaction" | "sourceInTransaction"
	>;
	referenceInputs: MemoryService["referenceInputs"];
	records?: AgencyRecordInputDeps;
	blocked(db: Database, messageId: string): boolean;
	enabled?(db: Database): boolean;
}

export function pendingGoalQuestions(
	db: Database,
	ports: GoalQuestionDeliveryPorts,
	now: number,
) {
	if (ports.enabled?.(db) === false) return [];
	const { goals, conversation } = ports;
	return goals.progressRowsInTransaction(db).flatMap((row) => {
		const sourceRef = row.state.sourceRef;
		if (
			!sourceRef ||
			!row.state.questions.some(
				(question) => !question.answeredBy && !question.resolution,
			)
		)
			return [];
		const access = goalAccess(row);
		if (!goals.activeProgressInTransaction(db, access, row)) return [];
		const goal = goals.currentGoalInTransaction(db, access, row.goalId)!;
		const source = conversation.sourceInTransaction(db, sourceRef);
		if (source.state !== "available" || source.message.role !== "user")
			return [];
		const destination =
			row.deliveryConversationId ?? source.message.conversationId;
		const control = goals.goalScopeControlInTransaction(
			db,
			access,
			row.ledgerScope,
		);
		const due = Math.max(control?.speechUntilMs ?? 0, control?.allUntilMs ?? 0);
		return row.state.questions.flatMap((question) => {
			const id = goalQuestionMessageId(row, question.ref);
			if (
				question.answeredBy ||
				question.resolution ||
				canResolveGoalQuestion(row.state, question) ||
				(question.owner && question.owner.expiresAtMs <= Math.max(now, due)) ||
				conversation.sourceInTransaction(db, id).state !== "missing"
			)
				return [];
			const sources = questionSources(db, ports, row, question, now);
			if (!sources || sources.some((ref) => ports.blocked(db, ref))) return [];
			const input = captureGoalSources(
				db,
				ports.referenceInputs,
				sources,
				ports.records,
			);
			return input.complete
				? [
						{
							id,
							conversationId: destination,
							text: `目標「${goal.desiredState}」について確認です。\n\n${question.question}`,
							due,
							input,
						},
					]
				: [];
		});
	});
}

function questionSources(
	db: Database,
	{ goals }: GoalQuestionDeliveryPorts,
	row: GoalProgress,
	question: GoalQuestion,
	now: number,
) {
	const access = goalAccess(row);
	const attempt =
		question.owner &&
		goals.goalAttemptInTransaction(db, access, row, question.owner.attemptId);
	const permit = goals.goalPermitInTransaction(
		db,
		access,
		row,
		attempt?.permitId,
	);
	if (
		question.owner &&
		(!attempt ||
			attempt.outcome !== "running" ||
			attempt.ownerWorkId !== question.owner.ownerWorkId ||
			!permit ||
			permit.revoked ||
			permit.revision !== attempt.permitRevision ||
			(permit.scope.expiresAtMs ?? Infinity) <= now)
	)
		return null;
	return [
		...new Set([
			row.state.sourceRef!,
			...(question.inputSources ??
				row.state.evidence.flatMap(({ sources }) => sources ?? [])),
			...(permit?.scope.basis.kind === "message"
				? permit.scope.basis.sourceRefs
				: []),
		]),
	];
}
