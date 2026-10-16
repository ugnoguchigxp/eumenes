import { configureInTransaction, settingsReceipt } from "./settings";
import type { Database } from "bun:sqlite";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import { sha256Hex } from "../../../infrastructure/digest";
import { sdkTerminal, type SdkActivity, type SdkReceipt } from "../../coding";
import { sdkEventsSchema } from "../../coding";
import { codingCanonicalJSON as canonicalJSON } from "../../coding";
import { attempt, pending, readSettings } from "../repository";
import { enqueueSchema, type CodexEnqueue } from "../contracts";

export function createCodexTasks(options: {
	store: SqliteStore;
	now?: () => number;
}) {
	const now = options.now ?? Date.now;
	function enqueueInTransaction(tx: Database, value: CodexEnqueue) {
		const input = enqueueSchema.parse(value);
		const digest = sha256Hex(canonicalJSON(input.spec));
		const existing = attempt(tx, input.runId);
		if (existing) {
			if (
				existing.digest !== digest ||
				existing.scope !== input.scope ||
				existing.cardId !== input.cardId ||
				existing.requestId !== input.requestId ||
				existing.workerRevision !== input.workerRevision ||
				existing.settingsRevision !== input.settingsRevision ||
				existing.runnerId !== input.runnerId ||
				existing.executorRevision !== input.executorRevision ||
				existing.workspaceRef !== input.workspaceRef ||
				existing.guardEpoch !== input.guardEpoch
			)
				throw new Error("codex_request_conflict");
			return existing;
		}
		tx.query(
			"INSERT INTO codex_task_attempts(id,scope,card_id,run_id,request_id,spec_json,input_digest,worker_revision,settings_revision,runner_id,executor_revision,workspace_ref,guard_epoch,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'accepted',?,?)",
		).run(
			input.runId,
			input.scope,
			input.cardId,
			input.runId,
			input.requestId,
			canonicalJSON(input.spec),
			digest,
			input.workerRevision,
			input.settingsRevision,
			input.runnerId,
			input.executorRevision,
			input.workspaceRef,
			input.guardEpoch,
			now(),
			now(),
		);
		return attempt(tx, input.runId)!;
	}
	function observeInTransaction(
		tx: Database,
		scope: string,
		id: string,
		value: { receipt: SdkReceipt; events: SdkActivity[] },
	) {
		const current = attempt(tx, id);
		if (!current || current.scope !== scope)
			throw new Error("codex_attempt_missing");
		const { receipt, events } = sdkEventsSchema.parse(value);
		if (
			receipt.executionId !== current.id ||
			receipt.ownerId !== current.spec.ownerId ||
			receipt.workspaceId !== current.spec.workspaceId ||
			receipt.digest !== current.digest ||
			(current.epoch && current.epoch !== receipt.epoch)
		)
			throw new Error("codex_execution_identity_mismatch");
		if (
			receipt.git &&
			(!current.spec.git ||
				receipt.git.groupId !== current.id ||
				receipt.git.remoteId !== current.spec.git.remoteId ||
				(receipt.git.pushVerified &&
					(!receipt.git.commitVerified ||
						!receipt.git.commitSha ||
						receipt.git.remoteSha !== receipt.git.commitSha)) ||
				(receipt.git.commitVerified && !receipt.git.commitSha))
		)
			throw new Error("codex_git_identity_mismatch");
		if (
			current.spec.git &&
			receipt.state === "succeeded" &&
			(!receipt.git ||
				receipt.git.unknown ||
				!(current.spec.git.mode === "commit"
					? receipt.git.commitVerified
					: receipt.git.pushVerified))
		)
			throw new Error("codex_git_result_unconfirmed");
		if (
			current.receipt?.git?.commitVerified &&
			(!receipt.git?.commitVerified ||
				current.receipt.git.commitSha !== receipt.git.commitSha)
		)
			throw new Error("codex_git_commit_conflict");
		if (current.adopted) return null;
		if (
			receipt.seq < current.seq ||
			events.some((event) => event.seq > receipt.seq)
		)
			throw new Error("codex_event_cursor_invalid");
		let seq = current.seq;
		for (const event of events) {
			if (event.seq <= seq) {
				const previous = tx
					.query(
						"SELECT event_json FROM codex_task_events WHERE attempt_id=? AND seq=?",
					)
					.get(id, event.seq) as { event_json: string } | null;
				if (!previous || previous.event_json !== canonicalJSON(event))
					throw new Error("codex_event_conflict");
				continue;
			}
			if (event.seq !== seq + 1) throw new Error("codex_event_gap");
			tx.query("INSERT INTO codex_task_events VALUES(?,?,?)").run(
				id,
				event.seq,
				canonicalJSON(event),
			);
			seq = event.seq;
		}
		// A final receipt is not adopted until all earlier activity is durable locally.
		const caughtUp = seq === receipt.seq;
		const state = caughtUp ? receipt.state : current.state;
		if (
			current.seq === seq &&
			current.receipt &&
			canonicalJSON(current.receipt) === canonicalJSON(receipt)
		)
			return current;
		if (
			caughtUp &&
			["succeeded", "blocked", "failed", "cancelled"].includes(state) &&
			!receipt.managedExecutionStopped
		)
			throw new Error("codex_result_unconfirmed");
		if (sdkTerminal(current.state) && state !== current.state)
			throw new Error("codex_terminal_conflict");
		if (
			caughtUp &&
			["succeeded", "blocked"].includes(state) &&
			(!receipt.managedExecutionStopped ||
				!receipt.report ||
				(state === "succeeded" && receipt.report.outcome !== "done") ||
				(state === "blocked" && receipt.report.outcome !== "blocked"))
		)
			throw new Error("codex_result_unconfirmed");
		tx.query(
			"UPDATE codex_task_attempts SET published=1,epoch=?,state=?,event_seq=?,receipt_json=?,updated_at=? WHERE id=? AND adopted=0",
		).run(
			receipt.epoch,
			state,
			seq,
			caughtUp
				? canonicalJSON(receipt)
				: current.receipt
					? canonicalJSON(current.receipt)
					: null,
			now(),
			id,
		);
		return attempt(tx, id)!;
	}

	return {
		enqueueInTransaction,
		observeInTransaction,
		configureInTransaction,
		settingsReceiptInTransaction: settingsReceipt,
		markTrackingLostInTransaction(tx: Database, id: string) {
			const current = attempt(tx, id);
			if (!current || current.adopted) return null;
			const stamp = new Date(now()).toISOString();
			return observeInTransaction(tx, current.scope, id, {
				events: [],
				receipt: {
					protocol: "eumenes-codex-sdk/1",
					executionId: id,
					ownerId: current.spec.ownerId,
					workspaceId: current.spec.workspaceId,
					digest: current.digest,
					epoch: current.epoch ?? `lost-${id}`,
					state: "unknown",
					seq: current.seq,
					threadId: current.receipt?.threadId,
					reason: "tracking_lost",
					managedExecutionStopped: false,
					workspaceReleaseConfirmed: false,
					workspaceHeld: true,
					createdAt: current.receipt?.createdAt ?? stamp,
					updatedAt: stamp,
				},
			});
		},
		settingsInTransaction: readSettings,
		settings: () => options.store.readSnapshot(readSettings),
		attemptInTransaction: (tx: Database, scope: string, id: string) => {
			const current = attempt(tx, id);
			return current?.scope === scope ? current : null;
		},
		pending: () => options.store.readSnapshot(pending),
		latestForCardInTransaction: (
			tx: Database,
			scope: string,
			cardId: string,
		) => {
			const row = tx
				.query(
					"SELECT id FROM codex_task_attempts WHERE scope=? AND card_id=? ORDER BY seq DESC LIMIT 1",
				)
				.get(scope, cardId) as { id: string } | null;
			return row ? attempt(tx, row.id) : null;
		},
		latestExecutedForCardInTransaction: (
			tx: Database,
			scope: string,
			cardId: string,
		) => {
			const row = tx
				.query(
					"SELECT id FROM codex_task_attempts WHERE scope=? AND card_id=? AND published=1 ORDER BY seq DESC LIMIT 1",
				)
				.get(scope, cardId) as { id: string } | null;
			return row ? attempt(tx, row.id) : null;
		},
		beginPublishInTransaction: (tx: Database, id: string) =>
			tx
				.query(
					"UPDATE codex_task_attempts SET published=1,state='starting',updated_at=? WHERE id=? AND state='accepted' AND published=0 AND adopted=0",
				)
				.run(now(), id).changes === 1,
		markAdoptedInTransaction: (tx: Database, id: string) => {
			const current = attempt(tx, id);
			if (
				!current?.receipt ||
				!sdkTerminal(current.state) ||
				current.receipt.seq !== current.seq
			)
				throw new Error("codex_adoption_unconfirmed");
			tx.query(
				"UPDATE codex_task_attempts SET adopted=1,updated_at=? WHERE id=?",
			).run(now(), id);
		},
		requestStopInTransaction: (tx: Database, id: string) =>
			tx
				.query(
					"UPDATE codex_task_attempts SET stop_requested=1 WHERE id=? AND adopted=0",
				)
				.run(id).changes === 1,
		cancelQueuedInTransaction: (tx: Database, id: string) =>
			tx
				.query(
					"UPDATE codex_task_attempts SET state='cancelled',adopted=1,updated_at=? WHERE id=? AND state='accepted' AND published=0",
				)
				.run(now(), id).changes === 1,
		activityInTransaction: (
			tx: Database,
			scope: string,
			id: string,
			after: number,
			limit = 100,
		): SdkActivity[] => {
			if (attempt(tx, id)?.scope !== scope)
				throw new Error("codex_attempt_missing");
			if (
				!Number.isSafeInteger(after) ||
				after < 0 ||
				!Number.isSafeInteger(limit) ||
				limit < 1 ||
				limit > 500
			)
				throw new Error("codex_event_cursor_invalid");
			return (
				tx
					.query(
						"SELECT event_json FROM codex_task_events WHERE attempt_id=? AND seq>? ORDER BY seq LIMIT ?",
					)
					.all(id, after, limit) as { event_json: string }[]
			).map((row) => JSON.parse(row.event_json));
		},
	};
}
export type CodexTasks = ReturnType<typeof createCodexTasks>;
