import type { Database } from "bun:sqlite";
import { sha256Hex } from "../../infrastructure/digest";
import { configureSchema, type CodexSettings } from "./contracts";
import { readSettings } from "./repository";
export function settingsReceipt(
	tx: Database,
	id: string,
): CodexSettings | null {
	const row = tx
		.query(
			"SELECT receipt_json FROM codex_task_settings_receipts WHERE request_id=?",
		)
		.get(id) as { receipt_json: string } | null;
	return row ? JSON.parse(row.receipt_json) : null;
}
export function configureInTransaction(
	tx: Database,
	input: unknown,
	allowed: {
		runners: readonly string[];
		workspaces: readonly string[];
		resources: readonly string[];
	},
	requestId?: string,
) {
	const change = configureSchema.parse(input);
	const digest = sha256Hex(JSON.stringify(change));
	if (requestId) {
		const existing = tx
			.query(
				"SELECT digest,receipt_json FROM codex_task_settings_receipts WHERE request_id=?",
			)
			.get(requestId) as { digest: string; receipt_json: string } | null;
		if (existing) {
			if (existing.digest !== digest) throw new Error("request_conflict");
			return JSON.parse(existing.receipt_json) as CodexSettings;
		}
	}
	const current = readSettings(tx);
	if (current.revision !== change.expectedRevision)
		throw new Error("revision_conflict");
	if (
		(change.runnerId && !allowed.runners.includes(change.runnerId)) ||
		(change.workspaceId && !allowed.workspaces.includes(change.workspaceId)) ||
		(change.resourceId && !allowed.resources.includes(change.resourceId))
	)
		throw new Error("codex_configuration_unregistered");
	if (
		change.enabled &&
		(!change.runnerId || !change.workspaceId || !change.resourceId)
	)
		throw new Error("codex_configuration_incomplete");
	tx.query(
		"UPDATE codex_task_settings SET revision=revision+1,enabled=?,runner_id=?,workspace_id=?,resource_id=? WHERE id=1",
	).run(
		change.enabled ? 1 : 0,
		change.runnerId,
		change.workspaceId,
		change.resourceId,
	);
	const receipt = readSettings(tx);
	if (requestId)
		tx.query("INSERT INTO codex_task_settings_receipts VALUES(?,?,?)").run(
			requestId,
			digest,
			JSON.stringify(receipt),
		);
	return receipt;
}
