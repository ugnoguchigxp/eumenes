import type { Database } from "bun:sqlite";
import type { CodexAttempt, CodexSettings } from "../contracts";

export function attempt(tx: Database, id: string): CodexAttempt | null {
	const row = tx
		.query("SELECT * FROM codex_task_attempts WHERE id=?")
		.get(id) as {
		id: string;
		scope: string;
		card_id: string;
		run_id: string;
		request_id: string;
		spec_json: string;
		input_digest: string;
		worker_revision: string;
		settings_revision: number;
		runner_id: string;
		executor_revision: number;
		workspace_ref: string;
		guard_epoch: string;
		state: CodexAttempt["state"];
		published: number;
		epoch: string | null;
		event_seq: number;
		receipt_json: string | null;
		adopted: number;
		stop_requested: number;
	} | null;
	return row
		? {
				id: row.id,
				scope: row.scope,
				cardId: row.card_id,
				runId: row.run_id,
				requestId: row.request_id,
				spec: JSON.parse(row.spec_json),
				digest: row.input_digest,
				workerRevision: row.worker_revision,
				settingsRevision: row.settings_revision,
				runnerId: row.runner_id,
				executorRevision: row.executor_revision,
				workspaceRef: row.workspace_ref,
				guardEpoch: row.guard_epoch,
				state: row.state,
				published: row.published === 1,
				epoch: row.epoch,
				seq: row.event_seq,
				receipt: row.receipt_json ? JSON.parse(row.receipt_json) : null,
				adopted: row.adopted === 1,
				stopRequested: row.stop_requested === 1,
			}
		: null;
}
export function readSettings(tx: Database): CodexSettings {
	const row = tx
		.query(
			"SELECT revision,enabled,runner_id,workspace_id,resource_id FROM codex_task_settings WHERE id=1",
		)
		.get() as {
		revision: number;
		enabled: number;
		runner_id: string | null;
		workspace_id: string | null;
		resource_id: string | null;
	};
	return {
		revision: row.revision,
		enabled: row.enabled === 1,
		runnerId: row.runner_id,
		workspaceId: row.workspace_id,
		resourceId: row.resource_id,
	};
}
export const pending = (tx: Database): CodexAttempt[] =>
	(
		tx
			.query("SELECT id FROM codex_task_attempts WHERE adopted=0 ORDER BY seq")
			.all() as { id: string }[]
	).map(({ id }) => attempt(tx, id)!);
