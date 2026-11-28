import type { Database } from "bun:sqlite";
import type {
	GoalAccess,
	GoalHost,
	GoalProgress,
	GoalReplyWorkPort,
	GoalStore,
	GoalTarget,
	GoalWorkPermission,
	GoalPermitScope,
} from "eumenes-agency/agenda/runtime";
import type { ConversationService } from "../../domains/conversation";
import type { SqliteStore } from "../../infrastructure/sqlite";
import { goalDigest } from "./goal-progress-context";
import type { createGoalProgress } from "./goal-progress";
import type { GoalWorkspaceRegistry } from "./goal-workspaces";

type WorkPorts = {
	readonly store: Pick<SqliteStore, "read" | "write">;
	readonly goals: GoalStore;
	readonly progress: Pick<
		ReturnType<typeof createGoalProgress>,
		"submitInTransaction" | "wake"
	>;
	readonly conversation: Pick<ConversationService, "sourceInTransaction">;
	readonly blocked: (db: Database, messageId: string) => boolean;
	readonly workspaces: GoalWorkspaceRegistry;
	readonly binding: (db: Database) => { toolchainRevisionId: string } | null;
	readonly reconcileConfiguration?: (
		db: Database,
		row: GoalProgress,
	) => GoalProgress;
	readonly readPolicy?: (db: Database) => {
		toolchainRevisionId: string;
		scope: GoalPermitScope;
		workspace: string;
		impact: string;
	} | null;
	readonly access: GoalAccess;
	readonly scopeKey: string;
	readonly nowMs?: () => number;
};
type UserWords = Parameters<GoalReplyWorkPort["register"]>[1];

function slotProgress(
	goals: GoalStore,
	db: Database,
	access: GoalAccess,
	goalId: string,
	revision: number,
) {
	const key = { principal: access.principal, goalId, goalRevision: revision };
	return (
		goals.progressInTransaction(db, access, key) ??
		(revision > 1
			? goals.progressInTransaction(db, access, {
					...key,
					goalRevision: revision - 1,
				})
			: null)
	);
}
function createGoalList(ports: WorkPorts) {
	const { store, goals, access } = ports;
	return (legacy?: GoalHost) =>
		store.read((db) => {
			const reports = goals.goalReportsInTransaction(db, access);
			let mockSlots: ReturnType<GoalHost["list"]> | undefined;
			const slots = goals.listInTransaction(db, access).map((slot) => {
				const base = {
					...slot,
					progress: null,
					designNoteId: null,
					designDigest: null,
					mayStartAt: null,
					mockAuthorized: false,
				};
				const goal = slot.goal;
				if (!goal) return base;
				const row = slotProgress(goals, db, access, goal.goalId, goal.revision);
				if (row?.mode !== "goal") {
					mockSlots ??= legacy?.list();
					const mock = mockSlots?.find(
						(item) =>
							item.slot === slot.slot &&
							item.goal?.goalId === goal.goalId &&
							item.goal.revision === goal.revision,
					);
					return { ...(mock ?? base), mode: "mock" };
				}
				const attempt = goals.goalAttemptsInTransaction(db, access, row).at(-1);
				const permit = goals.goalPermitInTransaction(db, access, row);
				const permits = goals.goalPermitsInTransaction(db, access, row);
				return {
					...base,
					mode: "goal",
					progressVersion: row.progressVersion,
					designNoteId: row.state.design?.id ?? null,
					designDigest: row.state.design?.digest ?? null,
					progress: {
						state: row.phase,
						reason: row.state.problem ?? row.state.watch?.condition ?? null,
						attempt: attempt && {
							id: attempt.id,
							request: attempt.step.request,
							outcome: attempt.outcome,
							observed: attempt.observed,
						},
						unmet: row.state.criteria.filter(({ status }) => status === "open"),
						next: row.state.next,
						watch: row.state.watch,
						review: row.state.review,
						questions: row.state.questions
							.filter(
								({ answeredBy, resolution }) => !answeredBy && !resolution,
							)
							.map(({ ref, criterionIds, missing, question, owner }) => ({
								ref,
								criterionIds,
								missing,
								question,
								...(owner && { owner }),
							})),
						evidence: row.state.evidence.map(({ ref, version }) => ({
							ref,
							version,
						})),
						reports: reports
							.filter(({ report }) => report.goalId === goal.goalId)
							.map(({ report }) => ({ id: report.id, text: report.text })),
					},
					permit: permit && {
						id: permit.id,
						revision: permit.revision,
						workspaceRef: permit.scope.workspaceRef,
					},
					permits: permits.map(({ id, revision, scope }) => ({
						id,
						revision,
						workspaceRef: scope.workspaceRef,
						basis: scope.basis.kind,
					})),
				};
			});
			return { slots, workspaces: ports.workspaces.list() };
		});
}
export function createGoalReplyWork(ports: WorkPorts) {
	const { store, goals, access } = ports;
	const clock = ports.nowMs ?? Date.now;
	const source = (id: string) => ({
		namespace: "conversation",
		kind: "message",
		id,
	});
	const sourceUnchanged = (
		db: Database,
		user: UserWords,
		conversationId: string,
	) => {
		const found = ports.conversation.sourceInTransaction(db, user.id);
		if (
			found.state !== "available" ||
			found.message.role !== "user" ||
			found.message.conversationId !== conversationId ||
			found.message.text !== user.text ||
			ports.blocked(db, user.id)
		)
			throw new Error("goal_source_not_current");
	};
	const list = createGoalList(ports);

	function authorize(
		db: Database,
		row: GoalProgress,
		request: GoalWorkPermission,
		user: UserWords,
		op: string,
	) {
		const grant = ports.workspaces.resolve(request, user.id);
		const binding = ports.binding(db);
		if (!grant || !binding) return null;
		return goals.authorizeWorkInTransaction(db, access, row, {
			...grant,
			...binding,
			operationKey: goalDigest([user.id, row.goalId, row.goalRevision, op]),
		});
	}
	function policyFor(db: Database) {
		const bound = ports.binding(db);
		const local =
			bound && ports.workspaces.readPolicy(bound.toolchainRevisionId);
		return bound && local
			? { ...local, ...bound }
			: (ports.readPolicy?.(db) ?? null);
	}
	function grantReadPolicy(db: Database, row: GoalProgress) {
		if (ports.reconcileConfiguration)
			return ports.reconcileConfiguration(db, row);
		if (goals.goalPermitInTransaction(db, access, row)) return row;
		const policy = policyFor(db);
		return policy
			? goals.authorizeWorkInTransaction(db, access, row, {
					...policy,
					operationKey: goalDigest([
						row.goalId,
						row.goalRevision,
						"read-policy",
						policy.toolchainRevisionId,
					]),
				}).progress
			: row;
	}
	/** A conversation's goal operations; `legacy` is the mock goals' host, absent where only real goals are named. */
	function workReply(
		conversationId: string,
		legacy?: GoalHost,
	): GoalReplyWorkPort {
		return {
			list: () => list(legacy),
			async register(input, user, signal) {
				const saved = await store.write((db) => {
					signal.throwIfAborted();
					sourceUnchanged(db, user, conversationId);
					const goal = goals.registerInTransaction(
						db,
						access,
						input.slot,
						{
							scopeKey: ports.scopeKey,
							source: source(user.id),
							sourceMessageIds: [user.id],
							operationKey: `${user.id}:${input.slot ?? "first"}`,
							desiredState: input.desiredState,
							priority: input.priority ?? 50,
						},
						{
							mode: "goal",
							sourceRef: user.id,
							deliveryConversationId: conversationId,
							startedAt: clock(),
						},
					);
					const row = goals.progressInTransaction(db, access, {
						principal: access.principal,
						goalId: goal.id,
						goalRevision: goal.revision,
					});
					const result =
						row && input.workPermission
							? authorize(db, row, input.workPermission, user, "register")
							: null;
					const granted = result?.progress ?? row;
					const next =
						granted && (ports.reconcileConfiguration || !input.workPermission)
							? grantReadPolicy(db, granted)
							: granted;
					if (next?.needsEnqueue) ports.progress.submitInTransaction(db, next);
					return {
						...goals
							.listInTransaction(db, access)
							.find((slot) => slot.goal?.goalId === goal.id),
						status: "registered",
						goalId: goal.id,
						revision: goal.revision,
						permissionStatus: result
							? result.permit.revoked
								? "revoked"
								: "authorized"
							: input.workPermission
								? "needs_input"
								: "not_requested",
						...(result && !result.permit.revoked
							? {
									permitId: result.permit.id,
									permitRevision: result.permit.revision,
								}
							: {}),
					};
				});
				ports.progress.wake();
				return saved;
			},
			async update(input, user, signal) {
				let wakeLegacy = false;
				const saved = await store.write((db) => {
					signal.throwIfAborted();
					sourceUnchanged(db, user, conversationId);
					const { slot, goalId, revision } = input;
					const target: GoalTarget = { slot, goalId, revision };
					const goal = goals.goalAtSlotInTransaction(db, access, target);
					const key = {
						principal: access.principal,
						goalId,
						goalRevision: revision,
					};
					const prior = goals.activeProgressInTransaction(db, access, key);
					const origin = {
						source: source(user.id),
						sourceMessageIds: [user.id],
					};
					if (input.action === "revise" || input.action === "withdraw") {
						const stored = goals.progressInTransaction(db, access, key);
						if (
							goal.status !== "adopted" ||
							(!prior && stored?.mode === "goal")
						)
							throw new Error("goal_target_not_current");
						const changed =
							input.action === "revise"
								? goals.reviseInTransaction(
										db,
										access,
										target,
										{
											...origin,
											...(input.desiredState !== null
												? { desiredState: input.desiredState }
												: {}),
											...(input.priority !== null
												? { priority: input.priority }
												: {}),
										},
										{
											sourceRef: user.id,
											deliveryConversationId:
												prior?.deliveryConversationId ?? null,
											startedAt: clock(),
										},
									)
								: goals.withdrawInTransaction(db, access, target, origin);
						if (prior) {
							const next = goals.progressInTransaction(db, access, {
								...key,
								goalRevision:
									input.action === "revise" ? changed.revision : revision,
							});
							if (next)
								ports.progress.submitInTransaction(
									db,
									input.action === "revise" ? grantReadPolicy(db, next) : next,
								);
						} else wakeLegacy = true;
						return { status: "updated", action: input.action, goalId };
					}
					if (!prior) throw new Error("goal_target_not_current");
					let next: GoalProgress | null = null;
					switch (input.action) {
						case "authorize_work": {
							if (!input.workPermission)
								throw new Error("goal_permission_required");
							const question =
								input.questionRef &&
								prior.state.questions.find(
									({ ref }) => ref === input.questionRef,
								);
							if (
								input.questionRef &&
								(!question ||
									question.resolution ||
									(question.answeredBy && question.answeredBy !== user.id))
							)
								throw new Error("goal_question_not_current");
							const granted = authorize(
								db,
								prior,
								input.workPermission,
								user,
								input.action,
							);
							if (!granted)
								return {
									status: "needs_input",
									reason: "goal_workspace_or_scope_unresolved",
								};
							if (granted.permit.revoked)
								return { status: "refused", reason: "goal_permit_not_current" };
							next = granted.status === "applied" ? granted.progress : null;
							if (question && !question.answeredBy) {
								const answer = goals.answerGoalQuestionInTransaction(
									db,
									access,
									prior,
									question.ref,
									user.id,
									clock(),
								);
								if (answer.status !== "applied")
									throw new Error("goal_question_not_current");
								if ("progress" in answer) next = answer.progress ?? next;
							}
							if (next) ports.progress.submitInTransaction(db, next);
							return {
								status: "updated",
								action: input.action,
								permitId: granted.permit.id,
								permitRevision: granted.permit.revision,
							};
						}
						case "revoke_work": {
							if (!input.permit) throw new Error("goal_permit_required");
							const revoked = goals.revokeWorkInTransaction(
								db,
								access,
								prior,
								input.permit.id,
								input.permit.revision,
							);
							if (revoked.status === "stale")
								throw new Error("goal_permit_not_current");
							if (revoked.status === "applied") next = revoked.progress;
							break;
						}
						case "answer_question": {
							if (!input.questionRef) throw new Error("goal_question_required");
							const answer = goals.answerGoalQuestionInTransaction(
								db,
								access,
								prior,
								input.questionRef,
								user.id,
								clock(),
							);
							if (answer.status === "stale" || answer.status === "conflict")
								throw new Error("goal_question_not_current");
							if (answer.status === "applied") next = answer.progress ?? null;
							break;
						}
						default:
							throw new Error("goal_operation_forbidden");
					}
					if (next) ports.progress.submitInTransaction(db, next);
					return { status: "updated", action: input.action, goalId };
				});
				if (wakeLegacy) legacy?.infoChanged();
				ports.progress.wake();
				return saved;
			},
		};
	}
	return Object.assign(workReply, { list: () => list() });
}
