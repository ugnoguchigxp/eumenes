import type { Database } from "bun:sqlite";
import { getLogger } from "../../../infrastructure/logger";
import {
	INTERACTION_POLICY,
	type InteractionStatus,
	type InteractionView,
} from "../contracts/command-interactions";
import type { Run } from "../contracts";
import { interactionById, listInteractions } from "../repository/interactions";
import type { Accept, DialogueDeps } from "./context";
import { createInteractionAnswers } from "./interaction-answers";
import { createInteractionCore } from "./interaction-core";
import { createInteractionRuns } from "./interaction-runs";

const log = getLogger("dialogue");
const TERMINAL_RUNS = ["completed", "failed", "cancelled", "interrupted"];

/**
 * Dialogue-owned interactions (spec §7): the question one command sub-agent asked, the answers,
 * and the frozen chain/package/binding refs the resumed run must use. Not a task state machine.
 */
export function createCommandInteractions(
	deps: DialogueDeps,
	accept: (db: Database, input: Accept) => { run: Run; fresh: boolean },
) {
	const { store, clock } = deps;
	const core = createInteractionCore(deps);
	const { nowMs, view, settle, expireDue } = core;
	function viewInTransaction(db: Database, interactionId: string) {
		const row = interactionById(db, interactionId);
		return row ? view(row) : null;
	}
	return {
		...createInteractionRuns(deps, core),
		...createInteractionAnswers(deps, core, accept),
		get(interactionId: string): InteractionView | null {
			return store.read((db) => viewInTransaction(db, interactionId));
		},
		viewInTransaction,

		list(filter: {
			conversationId: string;
			status?: InteractionStatus;
		}): InteractionView[] {
			return store.read((db) => {
				const now = nowMs();
				// The status is derived (an unanswered question past its time reads as expired),
				// so it is filtered here, not in SQL.
				return listInteractions(db, filter.conversationId, 200)
					.map((row) => view(row, now))
					.filter((item) => !filter.status || item.status === filter.status)
					.slice(0, 50);
			});
		},

		/**
		 * Expires unanswered questions, ends open interactions whose run is gone, deletes bodies
		 * 30 days after the end and the tombstones 30 days after that.
		 */
		async maintenance() {
			return await store.write((tx) => {
				const now = nowMs();
				const nowIso = clock();
				let expired = 0;
				let orphaned = 0;
				for (const row of tx
					.query(
						"SELECT id FROM command_interactions WHERE status='waiting_input' AND expires_at<=?",
					)
					.all(nowIso) as Array<{ id: string }>) {
					const found = interactionById(tx, row.id);
					if (found && expireDue(tx, found)) expired++;
				}
				for (const row of tx
					.query(
						`SELECT i.id FROM command_interactions i JOIN dialogue_runs r ON r.id=i.current_run_id
						 WHERE i.status IN ('ready','invoking') AND r.status IN (${TERMINAL_RUNS.map(() => "?").join(",")})`,
					)
					.all(...TERMINAL_RUNS) as Array<{ id: string }>) {
					const found = interactionById(tx, row.id);
					if (found && settle(tx, found, "cancelled", "run_ended")) orphaned++;
				}
				const bodyCutoff = new Date(
					now - INTERACTION_POLICY.bodyRetentionMs,
				).toISOString();
				const stripped = tx
					.query(
						`SELECT id FROM command_interactions WHERE ended_at IS NOT NULL AND ended_at<=? AND body_deleted_at IS NULL`,
					)
					.all(bodyCutoff) as Array<{ id: string }>;
				for (const row of stripped) {
					tx.query(
						`UPDATE command_interactions SET request_text=NULL,input_json=NULL,question_prompt=NULL,question_choices_json=NULL,body_deleted_at=? WHERE id=?`,
					).run(nowIso, row.id);
					tx.query(
						"UPDATE command_interaction_events SET payload_json=NULL WHERE interaction_id=?",
					).run(row.id);
				}
				const tombCutoff = new Date(
					now - INTERACTION_POLICY.tombstoneRetentionMs,
				).toISOString();
				tx.query(
					`DELETE FROM command_interaction_events WHERE interaction_id IN (SELECT id FROM command_interactions WHERE body_deleted_at IS NOT NULL AND body_deleted_at<=?)`,
				).run(tombCutoff);
				const removed = tx
					.query(
						`DELETE FROM command_interactions WHERE body_deleted_at IS NOT NULL AND body_deleted_at<=?`,
					)
					.run(tombCutoff).changes;
				if (expired || orphaned || stripped.length || removed)
					log.info("dialogue.interactions_maintained", {
						kind: "maintenance",
						applied: expired + orphaned,
						count: stripped.length + removed,
					});
				return { expired, orphaned, bodiesDeleted: stripped.length, removed };
			});
		},
	};
}
export type CommandInteractions = ReturnType<typeof createCommandInteractions>;
