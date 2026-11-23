import { getLogger } from "../../../infrastructure/logger";
import { FORGET_KEY } from "../contracts";
import {
	type ForgetExclusion,
	bumpInboxFailure,
	readInbox,
	resolveInbox,
} from "../repository";
import { noticeInTransaction } from "./notices";
import { executeForget } from "./steps/curate-forget";
import type { ClosureSettle, ClosureStepDefinition } from "./types";

const log = getLogger("steward");

/**
 * The closure delete of a forget: the forgets whose targets were excluded at once (the redesign, section 9.2) have
 * every version and what was derived from them removed, whether or not a conversation run is going. It asks no model.
 */
export const forgetClosure: ClosureStepDefinition = {
	id: "forget-closure",
	slot: "maintenance",
	prepare(env, unit) {
		const ids = (unit.targets.requests ?? []).filter(
			(id) => readInbox(env.db, id)?.state === "excluded",
		);
		// What the library holds excluded that no request names (a restored database): the target list is theirs too.
		const orphans = unit.targets.orphans ?? [];
		if (ids.length === 0 && orphans.length === 0)
			return { status: "stale", reason: "nothing_to_do" };
		return {
			status: "ready",
			targets: {
				requests: ids,
				urgent: true,
				...(orphans.length > 0 ? { orphans } : {}),
			},
		};
	},
	settle(env, input): ClosureSettle {
		const { db, deps } = env;
		const now = deps.clock();
		const results: unknown[] = [];
		const refs: ClosureSettle["refs"] = [];
		let failed = false;
		for (const id of input.targets.requests ?? []) {
			const row = readInbox(db, id);
			if (row?.state !== "excluded" || row.exclusion === null) continue;
			refs.push({ type: "request", id });
			const spec = JSON.parse(row.exclusion) as ForgetExclusion;
			let code: string | null = null;
			try {
				const effect = executeForget(
					{ db, deps, conversationId: row.conversationId },
					spec,
					{ close: true },
				);
				if (effect.status === "refused") code = effect.code;
			} catch (error) {
				log.warn(
					"steward.forget_closure_failed",
					{ reason: "forget_failed" },
					error,
				);
				code = "forget_failed";
			}
			if (code === null) {
				resolveInbox(db, id, "done", null, now);
				noticeInTransaction(
					deps,
					db,
					row.conversationId,
					"忘れる依頼を実行しました。",
					`${input.unitId}:${id}`,
				);
				results.push({ request: id, status: "applied" });
			} else {
				// The exclusion stays in force: the closure is tried again, whatever the count.
				bumpInboxFailure(db, id);
				failed = true;
				results.push({ request: id, status: "rejected", code });
			}
		}
		// What the library holds excluded that no request names (a restored database): closed under no conversation.
		const orphans = input.targets.orphans ?? [];
		if (orphans.length > 0) {
			let code: string | null = null;
			try {
				const effect = executeForget(
					{ db, deps, conversationId: FORGET_KEY },
					{
						itemIds: orphans,
						messageIds: [],
						claimIds: [],
						entityIds: [],
						goalIds: [],
					},
					{ close: true },
				);
				if (effect.status === "refused") code = effect.code;
			} catch (error) {
				log.warn(
					"steward.forget_closure_failed",
					{ reason: "forget_failed" },
					error,
				);
				code = "forget_failed";
			}
			results.push(
				code === null
					? { orphans: orphans.length, status: "applied" }
					: { orphans: orphans.length, status: "rejected", code },
			);
			if (code !== null) failed = true;
		}
		return {
			results,
			refs,
			...(failed
				? { failed: { code: "forget_closure_failed", count: true } }
				: {}),
		};
	},
};
