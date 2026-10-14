import { deleteDecisionsByRefs } from "../../repository";
import { resumeAfterCommit } from "../forgets";
import type { StepEnv } from "../types";

/** What one forget request asks to remove, after the model's refs were resolved to ids. */
export type ForgetSpec = {
	/** Memory State items. */
	itemIds: string[];
	/** Messages the model or the host chose to block. */
	messageIds: string[];
	/** World claims and entities. */
	claimIds: string[];
	entityIds: string[];
	goalIds: string[];
};
export type ForgetEffect =
	| { status: "forgotten"; blockedMessageIds: string[]; itemIds: string[] }
	| {
			status: "refused";
			code: "forget_limit" | "world_unavailable" | "evidence_incomplete";
	  };

const isLimit = (error: unknown) =>
	error instanceof Error && error.message === "forget_limit";

/**
 * One forget request, in order (sections 6.2 and F1, F3, F4, F7, F8, F10, F11 of the World plan):
 *  1. read what World and the goals stand on BEFORE anything is removed: the messages that are evidence of the
 *     claims and entities, and the goals (with the messages of all their revisions) that the request names or
 *     that are tied to the entities;
 *  2. take the World forget of the claims and entities as a durable intake;
 *  3. ONE memory forget blocks the item evidence, the chosen messages, those evidence messages and the goals'
 *     messages, and carries the goal ids as `derived` (the goals are deleted by the purge hook, which a
 *     restored older database runs again at startup);
 *  4. whatever message memory blocked also leaves World as a forgotten source.
 * The World forgets are resumed after the transaction commits. A refusal (the memory limit, World unavailable, evidence that could not be read whole)
 * leaves nothing of the request behind.
 */
export function executeForget(env: StepEnv, spec: ForgetSpec): ForgetEffect {
	const { db, deps, conversationId } = env;
	const { world, goals } = deps;
	db.exec("SAVEPOINT steward_forget");
	try {
		const messageIds = new Set(spec.messageIds);
		const wantsWorld = spec.claimIds.length + spec.entityIds.length > 0;
		if (wantsWorld && world) {
			const evidence = world.curation.evidenceMessagesOf(db, {
				scope: world.scope,
				claimIds: spec.claimIds,
				entityIds: spec.entityIds,
			});
			if (evidence.status !== "ok") return refuse("world_unavailable");
			// A partial evidence list would forget the claims and leave some of their messages behind: refused whole.
			if (!evidence.complete) return refuse("evidence_incomplete");
			for (const id of evidence.messageIds) messageIds.add(id);
		}
		let goalIds: string[] = [];
		if (goals && spec.goalIds.length + spec.entityIds.length > 0) {
			const resolved = goals.ops.resolveForgetInTransaction(db, {
				goalIds: spec.goalIds,
				entityIds: spec.entityIds,
			});
			goalIds = resolved.goalIds;
			for (const id of resolved.messageIds) messageIds.add(id);
		}
		const forgetIds: string[] = [];
		if (world && wantsWorld) {
			for (const result of [
				world.curation.forgetClaimsInTransaction(db, {
					scope: world.scope,
					claimIds: spec.claimIds,
				}),
				world.curation.forgetEntitiesInTransaction(db, {
					scope: world.scope,
					entityIds: spec.entityIds,
				}),
			]) {
				if (result.status === "unavailable") return refuse("world_unavailable");
				if (result.status === "accepted") forgetIds.push(result.forgetId);
			}
		}
		let blockedMessageIds: string[] = [];
		let itemIds: string[] = [];
		if (spec.itemIds.length + messageIds.size + goalIds.length > 0) {
			const outcome = deps.memory.forgetInTransaction(db, {
				conversationId,
				itemIds: spec.itemIds,
				messageIds: [...messageIds],
				...(goalIds.length > 0 ? { derived: { goalIds } } : {}),
			});
			blockedMessageIds = outcome.blockedMessageIds;
			itemIds = outcome.forgottenItemIds;
			if (world && blockedMessageIds.length > 0) {
				const source = world.curation.acceptSourceForgetInTransaction(db, {
					scope: world.scope,
					messageIds: blockedMessageIds,
					reasonCode: "SOURCE_BLOCKED",
					origin: "steward",
				});
				if (source.status === "accepted") forgetIds.push(source.forgetId);
			}
		}
		// The decisions that touched these claims, entities and goals go with them (F5).
		deleteDecisionsByRefs(db, {
			claimIds: spec.claimIds,
			entityIds: spec.entityIds,
			goalIds,
		});
		db.exec("RELEASE steward_forget");
		for (const id of forgetIds) resumeAfterCommit(deps, id);
		return { status: "forgotten", blockedMessageIds, itemIds };
	} catch (error) {
		db.exec("ROLLBACK TO steward_forget");
		db.exec("RELEASE steward_forget");
		if (isLimit(error)) return { status: "refused", code: "forget_limit" };
		throw error;
	}

	function refuse(
		code: "world_unavailable" | "evidence_incomplete",
	): ForgetEffect {
		db.exec("ROLLBACK TO steward_forget");
		db.exec("RELEASE steward_forget");
		return { status: "refused", code };
	}
}
