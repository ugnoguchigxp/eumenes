import { createIdlePlanner, type IdleCheckpoint } from "eumenes-agency";
import type { AgencySettings } from "./host-types";
import type { AgencyHostDeps, Conv } from "./host-types";
import { researchInput } from "./research";
import { resultInput } from "./memory";
import { currentInput } from "./input";
/** Persisted tickets are reconciled by their real effects; a missing voice receipt is never replayed. */
export async function recoverTickets(
	deps: AgencyHostDeps,
	c: Conv,
	now: number,
) {
	for (const ticket of c.runtime.snapshot().continuity?.issued ?? []) {
		if (ticket.action === "tool" && ticket.toolName === "find_toolchain") {
			c.runtime.recordResult(
				{
					ticketId: ticket.id,
					status: "interrupted",
					at: now,
					resultText:
						"検索の返却前に再起動しました。必要な検索は次の機会に判断します。",
				},
				resultInput(c, ticket.id),
			);
		} else if (ticket.action === "tool" && deps.state) {
			try {
				const input = researchInput(
					ticket,
					c.runtime,
					c.id,
					c.scope,
					c.epoch,
					now,
				);
				await deps.store.write((db) => {
					if (!currentInput(deps, db, resultInput(c, ticket.id)))
						throw new Error("agency_input_stale");
					deps.state!.startInTransaction(db, input);
				});
			} catch {
				c.runtime.recordResult(
					{
						ticketId: ticket.id,
						status: "interrupted",
						at: now,
						resultText: "再起動時に実行先または期限を確認できませんでした。",
					},
					resultInput(c, ticket.id),
				);
			}
		} else if (ticket.action === "speak") {
			const source = deps.store.read((db) =>
				deps.conversation.sourceInTransaction(
					db,
					`agency:${c.scope}:${ticket.id}`,
				),
			);
			c.runtime.recordResult(
				{
					ticketId: ticket.id,
					status:
						source.state === "available" ? "succeeded" : "outcome_unknown",
					at: now,
					resultText:
						source.state === "available"
							? source.message.text
							: "再起動前の音声配信結果は未確認です。",
				},
				resultInput(c, ticket.id),
			);
		}
	}
}

export function hostPlanner(
	id: string,
	cfg: AgencySettings,
	activeId: string | null,
	now: number,
	restore?: IdleCheckpoint,
) {
	const planner = createIdlePlanner(
		{ idleSec: cfg.idleSec, maxUnanswered: cfg.maxUnanswered },
		now,
		restore,
	);
	planner.setPaused(id !== activeId, now);
	return planner;
}
