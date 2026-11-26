import type { Database } from "bun:sqlite";
import type { ExecutionView } from "../../tool-runtime";
import type { ResourceRegistry } from "../../resources";
import { forgetWorkResources } from "../repository/resources";
import { createResourceLedger } from "./resource-ledger";

/**
 * The resources the agency's work made (its research and the assignments the user asked for): the agent holds the
 * work itself, so the conversation's ledger numbers what it made under the work's root, and a line of the agent that
 * reports the work shows them.
 */
export function agencyActionWork(
	resources: ResourceRegistry | undefined,
	now: () => number,
) {
	const ledger = createResourceLedger({
		clock: () => new Date(now()).toISOString(),
		id: () => crypto.randomUUID(),
	});
	return {
		/** Enters the resources of a finished work; a resource that no longer resolves invalidates the result. */
		sync(db: Database, view: ExecutionView, rootId: string) {
			if (!view.result) return;
			const links = (view.result.links ?? []).map((uri) => {
				const found = resources?.resolveInTransaction(db, uri);
				if (!found?.ok) throw new Error("agency_result_invalidated");
				return { uri, kind: found.resource.kind, label: found.resource.label };
			});
			ledger.enterLinksInTransaction(db, {
				conversationId: view.conversationId,
				workId: rootId,
				links,
			});
		},
		link(
			db: Database,
			conversationId: string,
			messageId: string,
			rootIds: readonly string[],
		) {
			ledger.linkMessageToWorkResourcesInTransaction(
				db,
				conversationId,
				messageId,
				rootIds,
			);
		},
	};
}

/** The work's origin was forgotten: the resources it made are no longer shown (their numbers stay taken). */
export function eraseAgencyActionWork(
	db: Database,
	work: { root_id: string },
	now: number,
) {
	forgetWorkResources(db, [{ id: work.root_id }], new Date(now).toISOString());
}
