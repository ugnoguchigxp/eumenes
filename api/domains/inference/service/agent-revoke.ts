import type { Database } from "bun:sqlite";
import type { AgentAttemptRevocation } from "../contracts";

/**
 * Marks the agent attempts that stood on a forgotten reference (a message or a memory item) as `revoked`: the ones still running, and the ones
 * that finished but whose answer is not adopted yet. A revoked attempt never becomes `succeeded` again, so its
 * receipt is refused at adoption. Returns the requests whose running call has to be aborted after the commit.
 * Idempotent: a second call finds nothing left to revoke.
 */
export function revokeAgentAttempts(
	db: Database,
	input: AgentAttemptRevocation,
	now = Date.now(),
): string[] {
	const messages = new Set(input.messageIds);
	const items = new Set(input.itemIds);
	if (!messages.size && !items.size) return [];
	const rows = db
		.query(
			`SELECT a.id, a.request_id AS requestId, a.refs FROM inference_attempts a
			 JOIN inference_requests r ON r.id=a.request_id
			 WHERE a.refs IS NOT NULL AND a.accepted=0
			 AND (a.status='running' OR (a.status='succeeded' AND r.status='pending'))`,
		)
		.all() as Array<{ id: string; requestId: string; refs: string }>;
	const requests = new Set<string>();
	for (const row of rows) {
		let refs: {
			messageIds?: string[];
			itemIds?: string[];
		};
		try {
			refs = JSON.parse(row.refs);
		} catch {
			continue;
		}
		if (
			!refs.messageIds?.some((id) => messages.has(id)) &&
			!refs.itemIds?.some((id) => items.has(id))
		)
			continue;
		db.query(
			"UPDATE inference_attempts SET status='revoked',reason='memory_forgotten',ended=COALESCE(ended,?) WHERE id=?",
		).run(now, row.id);
		requests.add(row.requestId);
	}
	return [...requests];
}
